import { Noctis, type Song, type StreamInfo } from './host'
import { DESKTOP_UA, gateHeaders, trackIdOf, WEBGATE } from './api'

/**
 * Audio, from Spotify itself (the way its web player gets it) — no more matching on
 * YouTube Music:
 *
 * - The web player's media API (track-playback/v1/media) lists the renditions of a
 *   track: clear MP3s and DRM-protected MP4s (AAC) and FLAC.
 * - Clear MP3: storage-resolve answers a direct CDN URL. Plays anywhere, and downloads.
 * - DRM MP4/FLAC: the file is CMAF (fragmented MP4) served from a CDN; the seektable
 *   describes its byte ranges (an init segment of `offset` bytes, then one range per
 *   segment). The whole file is fetched, joined into one blob, and Widevine decrypts
 *   it: the stream carries `drm` with the PSSH init data and the license endpoint, and
 *   the player's MediaKeys do the rest. Devices without a content decryption module
 *   (Android's WebView has none) fall back to the clear MP3.
 */

const { StreamError } = Noctis.libs.stream
const { ref } = Noctis.packages.vue
const { request, fetchRange } = Noctis.libs.http

/** Media type of each file format the web player knows (see its bundles). */
const MP3 = 'audio/mpeg'
const AAC = 'audio/mp4; codecs="mp4a.40.2"'
const FLAC = 'audio/mp4; codecs="flac"'
const FORMAT_MIME: Record<number, string> = {
  3: MP3, 4: MP3, 5: MP3, 6: MP3,
  10: AAC, 11: AAC, 12: AAC, 13: AAC, 14: AAC, 15: AAC,
  17: FLAC,
}

/** What the last play resolved to and why not better, shown in Settings → Spotify. */
export const streamReport = ref('Nothing played yet')
/** Play the clear MP3 even where DRM is possible (also the only downloadable kind). */
export const preferClear = ref(false)

export function initStreamPrefs(pluginStorage: { get<T>(key: string, fallback?: T): T | undefined }) {
  preferClear.value = pluginStorage.get('prefer-clear', false) ?? false
}

export function setPreferClear(value: boolean, storage: { set(key: string, value: unknown): void }) {
  preferClear.value = value
  storage.set('prefer-clear', value)
}

/* ------------------------------------------------------------------ *
 * Media: the renditions of a track
 * ------------------------------------------------------------------ */

interface FileEntry {
  file_id?: string
  file_url?: string
  format?: number | string
  bitrate?: number
  audio_quality?: string
  gain_db?: number
  hifi_status?: Record<string, unknown>
}

interface MediaManifest {
  file_ids_mp3?: FileEntry[]
  file_ids_mp4?: FileEntry[]
  file_ids_mp4flac?: FileEntry[]
}

async function mediaDoc(trackId: string): Promise<MediaManifest> {
  const params = new URLSearchParams([
    ['manifestFileFormat', 'MP3'],
    ['manifestFileFormat', 'MP4'],
    ['manifestFileFormat', 'MP4_FLAC'],
  ])
  const response = await request(`${WEBGATE}/track-playback/v1/media/${trackId}?${params}`, {
    headers: await gateHeaders(),
  })
  if (response.status !== 200) throw new StreamError(`Spotify's media API answered HTTP ${response.status}`)
  const media = (response.data as Record<string, any>)?.media?.[trackId]
  const error = media?.error ?? (response.data as Record<string, any>)?.error
  const manifest: MediaManifest | undefined = media?.manifest
  if (!manifest) {
    throw new StreamError(
      `Spotify has no audio for this track${error?.code ? ` (${error.code})` : ''}` + (error?.message ? `: ${error.message}` : ''),
    )
  }
  return manifest
}

/** A CDN URL for a file id: a direct https: link, valid for the ttl. */
async function cdnUrl(fileId: string, format: number): Promise<{ url: string; ttl: number }> {
  const response = await request(
    `${WEBGATE}/storage-resolve/v2/files/audio/interactive/${format}/${fileId}?version=10000000&product=9&platform=39&alt=json`,
    { headers: await gateHeaders() },
  )
  const urls = (response.data as Record<string, any>)?.cdnurl as string[] | undefined
  const url = urls?.find(Boolean)
  if (response.status !== 200 || !url) throw new StreamError(`Spotify's storage resolve answered HTTP ${response.status} with no file`)
  return { url, ttl: Number((response.data as Record<string, any>)?.ttl ?? 3600) }
}

/** The file's size, for downloads and progress bars; absent when the CDN won't say. */
async function contentLengthOf(url: string): Promise<number | undefined> {
  try {
    const response = await request(url, { method: 'HEAD' })
    const length = Number(response.headers['content-length'])
    return response.status < 400 && length > 0 ? length : undefined
  } catch {
    return undefined
  }
}

const bitrateOf = (entry: FileEntry) => Number(entry.bitrate ?? 0)
/** The rendition closest to what the app asks for: the cheapest in data saver mode. */
const chooseByBitrate = (entries: FileEntry[], efficient: boolean) =>
  [...entries].sort((a, b) => (efficient ? bitrateOf(a) - bitrateOf(b) : bitrateOf(b) - bitrateOf(a)))[0]

const labelOf = (entry: FileEntry) => {
  const kbps = Number(entry.bitrate ?? 0)
  const format = Number(entry.format ?? 0)
  const name = format === 17 ? 'FLAC' : format >= 10 ? 'MP4' : 'MP3'
  return kbps > 0 ? `${name} ${Math.round(kbps / 1000)} kbps` : name
}

/* ------------------------------------------------------------------ *
 * Clear MP3: a direct URL, like any podcast file
 * ------------------------------------------------------------------ */

async function clearStream(entry: FileEntry): Promise<StreamInfo> {
  if (!entry.file_id) throw new StreamError('the rendition has no file id')
  const format = Number(entry.format ?? 5) || 5
  const { url, ttl } = await cdnUrl(entry.file_id, format)
  return {
    url,
    mimeType: FORMAT_MIME[format] ?? MP3,
    bitrate: bitrateOf(entry) || 160_000,
    contentLength: await contentLengthOf(url),
    loudnessDb: entry.gain_db !== undefined ? Number(entry.gain_db) : undefined,
    expiresAt: Date.now() + ttl * 1000 - 60_000,
  }
}

/* ------------------------------------------------------------------ *
 * DRM MP4/FLAC: CMAF from the CDN, decrypted by the player's Widevine
 * ------------------------------------------------------------------ */

/** Whether this environment can open Widevine sessions at all (browsers and the
 * desktop shell can; Android's WebView can't). Asked once per run. */
let emeProbe: Promise<boolean> | null = null
export function emeAvailable(): Promise<boolean> {
  if (typeof navigator.requestMediaKeySystemAccess !== 'function') return Promise.resolve(false)
  emeProbe ??= navigator
    .requestMediaKeySystemAccess('com.widevine.alpha', [
      {
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: AAC, robustness: 'SW_SECURE_CRYPTO' }, { contentType: AAC }],
        distinctiveIdentifier: 'optional',
        persistentState: 'optional',
        sessionTypes: ['temporary'],
      },
    ])
    .then(
      () => true,
      () => false,
    )
  return emeProbe
}

interface Seektable {
  seektableVersion: number
  pssh?: { widevine?: string }
  offset?: number
  timescale?: number
  end_time_millis?: number
  segments?: { size?: number; duration?: number }[]
}

async function seektableOf(fileId: string): Promise<Seektable> {
  const response = await request(`https://seektables.spotifycdn.com/v1/seektable/${fileId}`, {
    headers: { 'user-agent': DESKTOP_UA },
  })
  const table = response.data as Record<string, any>
  if (response.status !== 200 || !table?.segments) throw new StreamError(`Spotify's seektable answered HTTP ${response.status}`)
  if (Number(table.seektableVersion) !== 2) throw new StreamError(`Unsupported seektable version ${table.seektableVersion}`)
  return table as Seektable
}

/** Where the license server is today (Spotify moves it around through "melody"). */
let licenseUrl: { url: string; expiresAt: number } | null = null
async function resolveLicenseUrl(): Promise<string> {
  if (licenseUrl && licenseUrl.expiresAt > Date.now() + 60_000) return licenseUrl.url
  try {
    const response = await request(`${WEBGATE}/melody/v1/license_url?keysystem=com.widevine.alpha&mediatype=audio&sdk_name=&sdk_version=`, {
      headers: await gateHeaders(),
    })
    const uri = String((response.data as Record<string, any>)?.uri ?? '')
    if (response.status === 200 && uri) {
      const url = /^https?:/.test(uri) ? uri : `${WEBGATE}/${uri.replace(/^\/+/, '')}`
      licenseUrl = { url, expiresAt: Date.now() + Number((response.data as Record<string, any>)?.expires ?? 600) * 1000 }
      return url
    }
  } catch {
    /* melody is an indirection; the fixed endpoint below is what Spotify falls back to */
  }
  return `${WEBGATE}/widevine-license/v1/audio/license`
}

const KEEP = 4
/** Whole protected files joined in memory, most recent first; the rest are revoked. */
const assembled = new Map<string, StreamInfo>()

function keep(key: string, info: StreamInfo) {
  assembled.delete(key)
  assembled.set(key, info)
  for (const [old, value] of assembled) {
    if (assembled.size <= KEEP) break
    URL.revokeObjectURL(value.url)
    assembled.delete(old)
  }
}

function bytesFromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** The whole protected file in one blob: an init segment of `offset` bytes, then each
 * segment's range, per the seektable (the ranges are contiguous, so one ranged request). */
async function joinedBlob(url: string, table: Seektable, mimeType: string): Promise<{ url: string; size: number }> {
  const offset = Math.max(0, Number(table.offset ?? 0))
  const segments = table.segments ?? []
  const total = segments.reduce((sum, segment) => sum + Number(segment.size ?? 0), offset)
  const result = await fetchRange(url, 0, Math.max(0, total - 1))
  const bytes = result.bytes ?? (result.base64 ? bytesFromBase64(result.base64) : new ArrayBuffer(0))
  if ((result.status !== 200 && result.status !== 206) || bytes.byteLength === 0) {
    throw new StreamError(`Spotify's file server answered HTTP ${result.status}`)
  }
  return { url: URL.createObjectURL(new Blob([bytes], { type: mimeType })), size: bytes.byteLength }
}

async function protectedStream(entry: FileEntry): Promise<StreamInfo> {
  const fileId = String(entry.file_id ?? '')
  if (!fileId) throw new StreamError('the rendition has no file id')
  const format = Number(entry.format ?? 15) || 15
  const mimeType = FORMAT_MIME[format] ?? AAC

  const [table, cdn] = await Promise.all([seektableOf(fileId), cdnUrl(fileId, format)])
  const initData = String(table.pssh?.widevine ?? '')
  if (!initData) throw new StreamError('the seektable carries no Widevine init data')

  const file = await joinedBlob(cdn.url, table, mimeType)
  return {
    url: file.url,
    mimeType,
    bitrate: bitrateOf(entry) || 256_000,
    contentLength: file.size,
    loudnessDb: entry.gain_db !== undefined ? Number(entry.gain_db) : undefined,
    expiresAt: Date.now() + Math.min(cdn.ttl * 1000 - 60_000, 20 * 60_000),
    drm: {
      system: 'com.widevine.alpha',
      initData,
      licenseUrl: await resolveLicenseUrl(),
      licenseHeaders: await gateHeaders(),
      certificateUrl: `${WEBGATE}/widevine-license/v1/application-certificate`,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  const trackId = trackIdOf(song)
  const cacheKey = `${trackId}:${efficient}:${preferClear.value ? 'clear' : 'auto'}`
  const cached = assembled.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 20_000) return cached

  const manifest = await mediaDoc(trackId)
  const mp3Entries = manifest.file_ids_mp3 ?? []
  const mp4Entries = manifest.file_ids_mp4 ?? []
  const flacEntries = manifest.file_ids_mp4flac ?? []
  const failures: string[] = []

  // The DRM rendition Spotify would serve first: FLAC when the account has it, else MP4.
  const protectedEntry = !efficient && flacEntries.length > 0 ? flacEntries[0] : chooseByBitrate(mp4Entries, efficient)
  const canDecrypt = await emeAvailable()

  if (!preferClear.value && protectedEntry) {
    if (canDecrypt) {
      try {
        const info = await protectedStream(protectedEntry)
        keep(cacheKey, info)
        streamReport.value = `DRM-protected ${labelOf(protectedEntry)} (Widevine)`
        return info
      } catch (error) {
        failures.push(`${labelOf(protectedEntry)}: ${(error as Error).message}`)
      }
    } else {
      failures.push(`${labelOf(protectedEntry)}: this device has no content decryption module`)
    }
  }

  const mp3 = chooseByBitrate(mp3Entries, efficient)
  if (mp3) {
    try {
      const info = await clearStream(mp3)
      const why = preferClear.value ? null : (failures[0] ?? (protectedEntry ? 'the DRM rendition failed' : 'no DRM rendition on offer'))
      streamReport.value = `Clear MP3 ${labelOf(mp3)}${why ? ` — DRM skipped: ${why}` : ''}`
      return info
    } catch (error) {
      failures.push(`MP3: ${(error as Error).message}`)
    }
  }

  streamReport.value = `No audio: ${failures.join('; ') || 'Spotify listed no renditions'}`
  throw new StreamError(
    failures.length > 0
      ? `Spotify's audio could not be played (${failures.join('; ')})`
      : 'Spotify has no audio for this track. Sign in with a Premium account, or the song may be unavailable in your region.',
  )
}
