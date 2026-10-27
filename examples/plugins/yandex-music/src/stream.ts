import { Noctis, type Song, type StreamInfo } from './host'
import { api, apiPost, numericTrackId, token, type Raw } from './api'

/**
 * Audio. Two flows, both ending in a plain https: URL an <audio> element plays:
 *
 * - get-file-info (signed in, preferred): the desktop app's flow — an HMAC-signed
 *   request that answers with direct file URLs (mp3/aac raw, or FLAC with Plus).
 * - download-info (fallback, works signed out): the classic flow — variants list, then
 *   an XML with host/path/ts/s, signed with the known salt into a get-mp3 URL.
 *
 * Both are built fresh at resolve time (links are short-lived), so the player always
 * gets a working URL. The CDN serves plain bytes, so playback and ranged downloads
 * need nothing special.
 */

const { StreamError } = Noctis.libs.stream
const { http } = Noctis.libs
const { ref } = Noctis.packages.vue

const DESKTOP_CLIENT = 'YandexMusicDesktopAppWindows/5.95.0'
const DESKTOP_SIGN_KEY = 'kzqU4XhfCaY6B6JTHODeq5'
const DOWNLOAD_SALT = 'XGRlBW9FXlekgbPrRHuSiA'

const MIME_BY_CODEC: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  'he-aac': 'audio/aac',
  flac: 'audio/flac',
  'flac-mp4': 'audio/mp4',
  'aac-mp4': 'audio/mp4',
  'he-aac-mp4': 'audio/mp4',
}

const mimeOf = (codec: string) => MIME_BY_CODEC[codec] ?? 'audio/mpeg'

async function hmacSha256(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const keyBytes = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', keyBytes, encoder.encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

/* ------------------------------------------------------------------ *
 * md5 — only for the download-info sign (no Web Crypto equivalent)
 * ------------------------------------------------------------------ */

/* eslint-disable */
function md5(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const withPadding = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  withPadding.set(bytes)
  withPadding[bytes.length] = 0x80
  const view = new DataView(withPadding.buffer)
  view.setUint32(withPadding.length - 8, bitLen >>> 0, true)
  view.setUint32(withPadding.length - 4, Math.floor(bitLen / 2 ** 32), true)

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let chunk = 0; chunk < withPadding.length; chunk += 64) {
    const M = new Uint32Array(16)
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(chunk + i * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D; D = C; C = B
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }
  // The digest is each word's bytes, least significant first.
  return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((shift) => ((v >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('')
}
/* eslint-enable */

/* ------------------------------------------------------------------ *
 * Flow A: get-file-info (signed in, direct URLs, includes FLAC)
 * ------------------------------------------------------------------ */

/** What the last play resolved to and, if the full-quality route failed, why (shown in settings). */
export const streamReport = ref('Nothing played yet')
/** The last quality check's answer, shown under its row. */
export const checkReport = ref('')

let fileInfoError = ''
/** When Yandex last answered a high-quality request with the free tier; high-quality attempts pause for a while after. */
let cappedAt = 0
const CAPPED_FOR = 30 * 60_000

/** Every codec the desktop app asks for; the encrypted transport serves fragmented-MP4 variants. */
const ALL_CODECS = ['flac', 'flac-mp4', 'aac', 'aac-mp4', 'he-aac', 'he-aac-mp4', 'mp3']

async function getFileInfo(trackId: string, quality: string, codecs: string[], transport: string, client = DESKTOP_CLIENT): Promise<Raw | null> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${timestamp}${trackId}${quality}${codecs.join('')}${transport}`
  const sign = (await hmacSha256(DESKTOP_SIGN_KEY, message)).replace(/=+$/, '')
  try {
    const result = await api<Raw>('/get-file-info', {
      ts: timestamp,
      trackId,
      quality,
      codecs: codecs.join(','),
      transports: transport,
      sign,
    }, { headers: { 'x-yandex-music-client': client } })
    const info = result?.downloadInfo ?? result ?? null
    if (info?.url || info?.urls?.length) return info
    fileInfoError = `${transport}/${quality}: no url`
  } catch (error) {
    fileInfoError = `${transport}/${quality}: ${(error as Error).message}`
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Encrypted files (transport "encraw"): high qualities are served only this way.
 * The file is AES-128-CTR with a zero counter and a hex key in the answer, so it's
 * fetched whole, decrypted with Web Crypto and played from a blob.
 * ------------------------------------------------------------------ */

const KEEP = 4
const decrypted = new Map<string, { url: string; size: number; mimeType: string; bitrate: number }>()

function keep(id: string, entry: { url: string; size: number; mimeType: string; bitrate: number }) {
  decrypted.delete(id)
  decrypted.set(id, entry)
  for (const [old, value] of decrypted) {
    if (decrypted.size <= KEEP) break
    URL.revokeObjectURL(value.url)
    decrypted.delete(old)
  }
}

async function decryptedBlob(url: string, keyHex: string, mimeType: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new StreamError(`Yandex Music's file server answered HTTP ${response.status}`)
  const encrypted = await response.arrayBuffer()
  const keyBytes = new Uint8Array((keyHex.match(/../g) ?? []).map((byte) => parseInt(byte, 16)))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: new Uint8Array(16), length: 128 }, key, encrypted)
  return new Blob([plain], { type: mimeType })
}

/* ------------------------------------------------------------------ *
 * Flow B: download-info + signed XML (works signed out, mp3/aac)
 * ------------------------------------------------------------------ */

interface Variant {
  codec: string
  bitrate: number
  downloadInfoUrl: string
  direct: boolean
  preview: boolean
}

async function downloadInfoVariants(numericId: string): Promise<Variant[]> {
  const list = await api<Raw[]>(`/tracks/${numericId}/download-info`)
  return (list ?? [])
    .filter((v: Raw) => v?.download_info_url)
    .map((v: Raw) => ({
      codec: String(v.codec ?? 'mp3'),
      bitrate: Number(v.bitrate_in_kbps ?? v.bitrateInKbps ?? 0),
      downloadInfoUrl: String(v.download_info_url ?? v.downloadInfoUrl),
      direct: Boolean(v.direct),
      preview: Boolean(v.preview),
    }))
}

async function directLinkFromXml(xmlUrl: string): Promise<string> {
  const response = await http.request(xmlUrl, { headers: { 'user-agent': 'Yandex-Music-API' } })
  const xml = String(response.data ?? '')
  const tag = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1]
  const host = tag('host')
  const path = tag('path')
  const ts = tag('ts')
  const s = tag('s')
  if (!host || !path || !ts || !s) throw new StreamError('Yandex Music did not return the audio link')
  const sign = md5(DOWNLOAD_SALT + path.slice(1) + s)
  return `https://${host}/get-mp3/${sign}/${ts}${path}`
}

async function directFromDownloadInfo(numericId: string, efficient: boolean): Promise<StreamInfo | null> {
  const variants = await downloadInfoVariants(numericId)
  const playable = variants.filter((v) => !v.preview)
  const pool = playable.length > 0 ? playable : variants
  const wanted = pool.filter((v) => v.codec === 'mp3' || v.codec === 'aac')
  if (wanted.length === 0) return null
  const rank = (v: Variant) => (efficient ? v.bitrate : -v.bitrate)
  const chosen = [...wanted].sort((a, b) => rank(a) - rank(b))[0]
  const url = chosen.direct ? chosen.downloadInfoUrl : await directLinkFromXml(chosen.downloadInfoUrl)
  return { url, mimeType: mimeOf(chosen.codec), bitrate: chosen.bitrate * 1000, expiresAt: Date.now() + 10 * 60_000 }
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  const numericId = numericTrackId(song.id)
  lastTrackId = numericId
  fileInfoError = ''
  const cached = decrypted.get(`${numericId}:${efficient}:${preferLossless.value}`)
  const soon = () => Date.now() + 20 * 60_000
  if (cached) return { url: cached.url, mimeType: cached.mimeType, bitrate: cached.bitrate, contentLength: cached.size, expiresAt: soon() }

  // Signed in: the desktop app's get-file-info. Encrypted first (the only way to high qualities), then plain.
  if (token.value) {
    const attempts: { quality: string; codecs: string[]; transport: string }[] = []
    if (!efficient && Date.now() - cappedAt > CAPPED_FOR) {
      if (preferLossless.value) attempts.push({ quality: 'lossless', codecs: ALL_CODECS, transport: 'encraw' })
      attempts.push({ quality: 'hq', codecs: ALL_CODECS, transport: 'encraw' })
    }
    attempts.push(
      !efficient && preferLossless.value ? { quality: 'lossless', codecs: ['flac', 'aac', 'mp3'], transport: 'raw' } : { quality: efficient ? 'nq' : 'hq', codecs: ['mp3', 'aac'], transport: 'raw' },
    )
    for (const attempt of attempts) {
      const info = await getFileInfo(numericId, attempt.quality, attempt.codecs, attempt.transport)
      const url = info?.url ?? (info?.urls ?? [])[0]
      if (!info || !url) continue
      const codec = String(info.codec ?? attempt.codecs[0])
      const bitrate = Number(info.bitrate || 0) * 1000 || (codec.startsWith('flac') ? 900_000 : attempt.quality === 'hq' ? 320_000 : 128_000)
      streamReport.value = `${codec.toUpperCase()} ${info.bitrate ? `${info.bitrate} kbps ` : ''}(asked ${attempt.quality} over ${attempt.transport}, got ${info.quality ?? '?'}${info.key ? ', encrypted' : ''})`
      // The free tier gains nothing from the encrypted route: a whole download and decrypt first for the same bytes the plain URL streams.
      if (info.key && info.quality === 'nq') {
        cappedAt = Date.now()
        continue
      }
      if (info.key) {
        try {
          const mimeType = mimeOf(codec)
          const blob = await decryptedBlob(url, String(info.key), mimeType)
          const entry = { url: URL.createObjectURL(blob), size: blob.size, mimeType, bitrate }
          keep(`${numericId}:${efficient}:${preferLossless.value}`, entry)
          return { url: entry.url, mimeType, bitrate, contentLength: entry.size, expiresAt: soon() }
        } catch (error) {
          fileInfoError = `decrypting ${codec}: ${(error as Error).message}`
          streamReport.value = `Could not play the encrypted file: ${(error as Error).message}`
          continue
        }
      }
      return { url, mimeType: mimeOf(codec), bitrate, expiresAt: Date.now() + 20 * 60_000 }
    }
  }

  // Fallback (and the only path signed out): the classic download-info flow.
  const direct = await directFromDownloadInfo(numericId, efficient)
  if (direct) {
    streamReport.value = `${direct.mimeType.replace('audio/', '').toUpperCase()} ${Math.round(direct.bitrate / 1000)} kbps via the fallback route${token.value && fileInfoError ? ` — ${fileInfoError}` : ''}`
    return direct
  }
  throw new StreamError(
    token.value
      ? 'Yandex Music has no audio for this track (check your Plus subscription or its availability in your region)'
      : 'Without signing in, Yandex Music only gives 30-second previews. Sign in to the plugin to play whole tracks',
  )
}

/** The track the quality check asks about: the last one played. */
let lastTrackId = ''

/**
 * Asks Yandex for every quality over both transports and a few client headers, and what
 * it says the account may do. For working out why a track plays at the quality it does.
 */
export async function qualityCheck(): Promise<string> {
  if (!token.value) return 'Sign in first'
  const lines: string[] = []
  try {
    const status = await api<Raw>('/account/status')
    lines.push(`plus: ${JSON.stringify(status.plus ?? null)}`)
    lines.push(`permissions: ${JSON.stringify(status.permissions?.values ?? null)}`)
    lines.push(`subscription: ${JSON.stringify(status.subscription ?? null).slice(0, 300)}`)
  } catch (error) {
    lines.push(`account/status failed: ${(error as Error).message}`)
  }
  const id = lastTrackId || '10994777'
  lines.push(`track ${id}${lastTrackId ? '' : ' (default; play a song first for yours)'}`)
  try {
    const [track] = await apiPost<Raw[]>('/tracks', { 'track-ids': id })
    const { available, availableForPremiumUsers, availableFullWithoutPermission, trackSource, disclaimers, contentWarning } = track ?? {}
    lines.push(`track flags: ${JSON.stringify({ available, availableForPremiumUsers, availableFullWithoutPermission, trackSource, disclaimers, contentWarning })}`)
  } catch (error) {
    lines.push(`track info failed: ${(error as Error).message}`)
  }
  try {
    const variants = await api<Raw[]>(`/tracks/${id}/download-info`)
    lines.push(`download-info: ${(variants ?? []).map((v) => `${v.codec}/${v.bitrateInKbps ?? v.bitrate_in_kbps}${v.preview ? 'preview' : ''}`).join(', ')}`)
  } catch (error) {
    lines.push(`download-info failed: ${(error as Error).message}`)
  }
  const clients = [DESKTOP_CLIENT, 'YandexMusicDesktopAppWindows/5.13.2']
  for (const transport of ['raw', 'encraw']) {
    for (const quality of ['nq', 'hq', 'lossless']) {
      const info = await getFileInfo(id, quality, transport === 'raw' ? ['flac', 'aac', 'mp3'] : ALL_CODECS, transport, clients[0])
      lines.push(`${transport} ${quality}: ${info ? `${info.codec} ${info.bitrate ?? '?'}kbps q=${info.quality}` : fileInfoError}`)
    }
  }
  // The whole answer to the most demanding request, minus the secrets.
  const full = await getFileInfo(id, 'lossless', ALL_CODECS, 'encraw', clients[0])
  if (full) {
    const { url, urls, key, ...rest } = full
    lines.push(`full answer (encraw lossless): ${JSON.stringify(rest)}; url host ${url ? new URL(url).host : '-'}; key ${key ? 'yes' : 'no'}`)
  }
  // The same song through the same flow with only the codec asked for, in case Yandex picks by codec.
  const flacOnly = await getFileInfo(id, 'lossless', ['flac'], 'encraw', clients[0])
  lines.push(`encraw lossless flac-only: ${flacOnly ? `${flacOnly.codec} q=${flacOnly.quality}` : fileInfoError}`)
  return lines.join('\n')
}

export const preferLossless = ref(true)

export function initStreamPrefs(pluginStorage: { get<T>(key: string, fallback?: T): T | undefined }) {
  preferLossless.value = pluginStorage.get('prefer-lossless', true) ?? true
}
