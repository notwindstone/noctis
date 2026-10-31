import { sourceOf, type Song, type StreamInfo } from '../models'
import { resolveChosen, resolveFallback } from '../playFrom'
import { writeLog } from '../plugins/log'
import { isDesktop } from '../native'
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
  // effectiveType is a rough latency guess that desktop webviews often get wrong ("3g" on a fast
  // line), which silently dropped YouTube Music to ~47 kbps; there only the Data Saver flag counts.
  return Boolean(connection?.saveData || (!isDesktop && /(^|-)2g|3g/.test(connection?.effectiveType ?? '')))
}

/**
 * A playable URL for a song: from where "Play from" says (a choice, or a copy on this
 * device), otherwise its service's `streams.resolve`.
 */
export async function resolveStream(song: Song): Promise<StreamInfo> {
  const cached = streams.get(song.id)
  // Leave a margin so a long song doesn't outlive its URL mid-playback.
  if (cached && cached.expiresAt - Date.now() > 20 * 60_000) return cached

  let stream: StreamInfo
  const efficient = preferEfficient()
  try {
    stream = (await resolveChosen(song, efficient)) ?? (await request(sourceOf(song), 'streams.resolve', { song, efficient }))
  } catch (error) {
    // Its own source can't play it (a song known only from metadata, a refused stream):
    // anything else that has it, e.g. a service that found it by searching.
    try {
      stream = await resolveFallback(song, efficient, error)
      writeLog('noctis', 'info', `"${song.title}" couldn't play from its own source (${(error as Error).message}); playing it from another one`)
    } catch {
      throw error instanceof StreamError ? error : new StreamError((error as Error).message || 'This song is not available.')
    }
  }
  if (!stream?.url) throw new StreamError('This song is not available.')
  streams.set(song.id, stream)
  return stream
}

export function forgetStream(songId: string) {
  streams.delete(songId)
}

/** Plugins resolve differently after an update: nothing resolved before it is kept. */
export function forgetStreams() {
  streams.clear()
}
