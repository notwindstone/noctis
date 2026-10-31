import { Noctis, type Song, type StreamInfo } from './host'
import { api, rawId, type Raw } from './api'

/**
 * Audio. SoundCloud streams are HLS now: AAC in fragmented MP4 (aac_160k, or aac_96k
 * for data saver), in ~10-second segments on a CDN that allows any origin.
 *
 * DRM-protected tracks (most label releases: "encrypted-hls") can't be played this way;
 * they fail with a clear message, and the player falls back to the song's other options.
 *
 * The app plays a URL in an <audio> element, which only some WebViews can do with HLS,
 * so a track is fetched whole and joined into one file (the init segment, then every
 * fragment), played as a blob: URL. That plays everywhere, seeks exactly and can be
 * saved for offline. Long tracks (DJ mixes, over LONG_TRACK) are played as HLS directly
 * where the WebView can, instead of being held in memory.
 */

const { StreamError } = Noctis.libs.stream

const LONG_TRACK = 20 * 60
const PARALLEL = 6
/** Joined files kept, so going back a song doesn't download it again. */
const KEEP = 4

interface Transcoding {
  url: string
  preset: string
  quality: string
  format: { protocol: string; mime_type: string }
}

const joined = new Map<string, { url: string; size: number; mimeType: string; bitrate: number }>()

function keep(id: string, entry: { url: string; size: number; mimeType: string; bitrate: number }) {
  joined.delete(id)
  joined.set(id, entry)
  for (const [old, value] of joined) {
    if (joined.size <= KEEP) break
    URL.revokeObjectURL(value.url)
    joined.delete(old)
  }
}

function pick(transcodings: Transcoding[], efficient: boolean): Transcoding | undefined {
  // Encrypted variants (DRM) and the adaptive master playlist can't be played this way.
  const usable = transcodings.filter((item) => (item.format.protocol === 'hls' || item.format.protocol === 'progressive') && !/mpegurl/.test(item.format.mime_type))
  const rank = (item: Transcoding) => {
    const kbps = Number(/(\d+)k/.exec(item.preset)?.[1] ?? (item.preset.startsWith('mp3') ? 128 : 64))
    return efficient ? kbps : -kbps
  }
  return [...usable].sort((a, b) => rank(a) - rank(b))[0]
}

const canPlayHls = () => document.createElement('audio').canPlayType('application/vnd.apple.mpegurl') !== ''

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.arrayBuffer()
    } catch (error) {
      if (attempt >= 2) throw error
      await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

/** Every segment of a media playlist, joined: EXT-X-MAP (the init segment) first. */
async function joinPlaylist(playlistUrl: string): Promise<Blob> {
  const text = await (await fetch(playlistUrl)).text()
  const base = new URL(playlistUrl)
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1]
  const segments = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const urls = [...(init ? [init] : []), ...segments].map((url) => new URL(url, base).href)
  const parts: ArrayBuffer[] = new Array(urls.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, urls.length) }, async () => {
      while (next < urls.length) {
        const index = next++
        parts[index] = await fetchBytes(urls[index])
      }
    }),
  )
  return new Blob(parts, { type: 'audio/mp4' })
}

export async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  const id = rawId(song.id)
  const cached = joined.get(`${id}:${efficient}`)
  // Never cached by the app (expiresAt within its 20-minute margin): the blob may be revoked later.
  const soon = () => Date.now() + 20 * 60_000
  if (cached) return { url: cached.url, mimeType: cached.mimeType, bitrate: cached.bitrate, contentLength: cached.size, expiresAt: soon() }

  const track = await api<Raw>(`/tracks/${id}`)
  if (track.policy === 'BLOCK') throw new StreamError('This track is not available in your country')
  const transcodings: Transcoding[] = track.media?.transcodings ?? []
  const transcoding = pick(transcodings, efficient)
  if (!transcoding) {
    // Label releases often come only DRM-encrypted (cbc/ctr-encrypted-hls); the player
    // then tries the song's other sources, e.g. YouTube Music found by searching.
    const encrypted = transcodings.some((item) => /encrypted/.test(item.format.protocol))
    throw new StreamError(encrypted ? "SoundCloud only has this track DRM-protected, which Noctis can't play" : 'SoundCloud has no stream this app can play for this track')
  }

  const { url } = await api<{ url: string }>(transcoding.url, { track_authorization: track.track_authorization })
  if (!url) throw new StreamError('SoundCloud refused the stream')
  const bitrate = Number(/(\d+)k/.exec(transcoding.preset)?.[1] ?? 128) * 1000
  const expires = Number(new URL(url).searchParams.get('expires')) * 1000 || Date.now() + 3600_000

  if (transcoding.format.protocol === 'progressive') {
    return { url, mimeType: transcoding.format.mime_type.split(';')[0], bitrate, expiresAt: expires }
  }
  const seconds = (track.duration ?? 0) / 1000
  if (seconds > LONG_TRACK && canPlayHls()) {
    return { url, mimeType: 'application/vnd.apple.mpegurl', bitrate, expiresAt: expires }
  }

  const blob = await joinPlaylist(url)
  const entry = { url: URL.createObjectURL(blob), size: blob.size, mimeType: 'audio/mp4', bitrate }
  keep(`${id}:${efficient}`, entry)
  return { url: entry.url, mimeType: entry.mimeType, bitrate, contentLength: entry.size, expiresAt: soon() }
}
