import { audioQuality } from '../preferences'
import { playerInnertube } from './client'
import { poTokenFor } from './potoken'

export interface StreamInfo {
  url: string
  mimeType: string
  bitrate: number
  contentLength?: number
  /** Normalisation hint from YouTube, in dB relative to the reference loudness. */
  loudnessDb?: number
  expiresAt: number
}

export class StreamError extends Error {}

const streams = new Map<string, StreamInfo>()

interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}

function preferEfficient(): boolean {
  if (audioQuality.value === 'low') return true
  if (audioQuality.value === 'high') return false
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  return Boolean(connection?.saveData || /(^|-)2g|3g/.test(connection?.effectiveType ?? ''))
}

export async function resolveStream(videoId: string): Promise<StreamInfo> {
  const cached = streams.get(videoId)
  // Leave a margin so a long song doesn't outlive its URL mid-playback.
  if (cached && cached.expiresAt - Date.now() > 20 * 60_000) return cached

  const yt = await playerInnertube()
  const info = await yt.music.getInfo(videoId)

  const status = info.playability_status
  if (status && status.status !== 'OK') {
    throw new StreamError(status.reason || 'This song is not available.')
  }

  const format = info.chooseFormat({
    type: 'audio',
    quality: preferEfficient() ? 'bestefficiency' : 'best',
    format: 'any',
  })

  // Without a proof-of-origin token googlevideo serves only the first ~1 MB.
  const [deciphered, poToken] = await Promise.all([format.decipher(yt.session.player), poTokenFor(videoId)])
  const url = `${deciphered}&pot=${encodeURIComponent(poToken)}`

  const expires = info.streaming_data?.expires
  const stream: StreamInfo = {
    url,
    mimeType: format.mime_type,
    bitrate: format.average_bitrate ?? format.bitrate,
    contentLength: format.content_length,
    loudnessDb: format.loudness_db,
    expiresAt: expires instanceof Date ? expires.getTime() : Date.now() + 5 * 3600_000,
  }

  streams.set(videoId, stream)
  return stream
}

export function forgetStream(videoId: string) {
  streams.delete(videoId)
}
