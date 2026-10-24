import { sourceOf, type Song, type StreamInfo } from '../models'
import { audioQuality } from '../preferences'
import { request } from './api'

export class StreamError extends Error {}

/** song id → stream; URLs from most services expire, so entries are checked on use. */
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

/** A playable URL for a song, from its service's `streams.resolve`. */
export async function resolveStream(song: Song): Promise<StreamInfo> {
  const cached = streams.get(song.id)
  // Leave a margin so a long song doesn't outlive its URL mid-playback.
  if (cached && cached.expiresAt - Date.now() > 20 * 60_000) return cached

  let stream: StreamInfo
  try {
    stream = await request(sourceOf(song), 'streams.resolve', { song, efficient: preferEfficient() })
  } catch (error) {
    throw error instanceof StreamError ? error : new StreamError((error as Error).message || 'This song is not available.')
  }
  if (!stream?.url) throw new StreamError('This song is not available.')
  streams.set(song.id, stream)
  return stream
}

export function forgetStream(songId: string) {
  streams.delete(songId)
}
