import type { Song, StreamInfo } from './host'
import { Noctis } from './host'
import { rotation } from './instances'

/**
 * Deezer, as Monochrome's "Deezer fallback" uses it: a Deezer streaming instance plays
 * any track by ISRC (/stream/?isrc=…&format=FLAC). Deezer has songs TIDAL's catalog
 * doesn't, so with one added, search also shows Deezer's results (its public API,
 * api.deezer.com), and TIDAL songs that won't stream fall back to it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>

const SOURCE = 'monochrome'
const { http } = Noctis.libs
const { StreamError } = Noctis.libs.stream

export const deezerId = (id: number | string) => `${SOURCE}:deezer:${id}`
export const isDeezer = (id: string) => id.startsWith(`${SOURCE}:deezer:`)

function toDeezerSong(track: Raw): Song {
  return {
    type: 'song',
    source: SOURCE,
    id: deezerId(track.id),
    title: track.title,
    artists: [{ name: track.artist?.name ?? 'Unknown artist' }],
    album: undefined,
    duration: track.duration,
    thumbnail: track.album?.cover_big ?? track.album?.cover_medium,
    explicit: Boolean(track.explicit_lyrics),
  }
}

export async function deezerSearch(query: string): Promise<Song[]> {
  const response = await http.request(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`, { headers: { accept: 'application/json' } })
  return (((response.data as Raw)?.data ?? []) as Raw[]).filter((track) => track.readable !== false).map(toDeezerSong)
}

async function isrcOf(song: Song): Promise<string> {
  const fromId = song.id.split(':')[3]
  if (fromId) return fromId
  const id = song.id.split(':')[2]
  const response = await http.request(`https://api.deezer.com/track/${id}`, { headers: { accept: 'application/json' } })
  const isrc = (response.data as Raw)?.isrc
  if (!isrc) throw new StreamError('Deezer has no ISRC for this track')
  return isrc
}

/** A stream by ISRC from a Deezer instance: FLAC, or MP3 320 for data saver. */
export async function deezerStream(song: Song, efficient: boolean): Promise<StreamInfo> {
  const isrc = await isrcOf(song)
  const format = efficient ? 'MP3_320' : 'FLAC'
  for (const instance of rotation('deezer')) {
    const url = `${instance.url}/stream/?isrc=${encodeURIComponent(isrc)}&format=${format}`
    // A one-byte request: is the instance up, and does it have this track?
    const probe = await http.request(url, { headers: { range: 'bytes=0-0' } }).catch(() => null)
    if (probe && (probe.status === 200 || probe.status === 206)) {
      return { url, mimeType: efficient ? 'audio/mpeg' : 'audio/flac', bitrate: efficient ? 320_000 : 0, expiresAt: Date.now() + 3600_000 }
    }
  }
  throw new StreamError("Your Deezer instances couldn't play this track")
}
