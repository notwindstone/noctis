import { finishTimes, parseLrc, parsePlain } from '../parse'
import type { Lyrics, LyricsSource, Query } from '../types'
import { asText, best, cleanTitle, http } from '../util'

interface Entry {
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const BASE = 'https://lrclib.net/api'

function toLyrics(entry: Entry): Lyrics | null {
  const base = { source: 'lrclib', sourceName: 'LRCLIB' }
  if (entry.instrumental) return { ...base, lines: [], sync: 'none', instrumental: true }
  if (entry.syncedLyrics) {
    const lines = parseLrc(entry.syncedLyrics)
    if (lines.length) return { ...base, lines: finishTimes(lines, entry.duration), sync: lines.some((line) => line.words?.length) ? 'word' : 'line' }
  }
  if (entry.plainLyrics) return { ...base, lines: parsePlain(entry.plainLyrics), sync: 'none' }
  return null
}

/** LRCLIB: free, open and keyless; synced lines for a lot of songs. */
export const lrclib: LyricsSource = {
  id: 'lrclib',
  name: 'LRCLIB',
  description: 'Open lyrics database. Line-synced, no account needed.',

  async get(query: Query) {
    const params = new URLSearchParams({
      track_name: cleanTitle(query.title),
      artist_name: query.artists[0] ?? '',
    })
    if (query.album) params.set('album_name', query.album)
    if (query.duration) params.set('duration', String(Math.round(query.duration)))

    // The exact lookup is the cheap, precise one.
    if (query.artists.length && query.duration) {
      const exact = await http(`${BASE}/get?${params}`)
      if (exact.status === 200 && typeof exact.data === 'object' && exact.data) {
        const lyrics = toLyrics(exact.data as Entry)
        if (lyrics) return lyrics
      }
    }

    const search = new URLSearchParams({ track_name: cleanTitle(query.title) })
    if (query.artists[0]) search.set('artist_name', query.artists[0])
    const found = await http(`${BASE}/search?${search}`)
    if (found.status !== 200) throw new Error(`LRCLIB answered ${found.status}: ${asText(found.data).slice(0, 80)}`)
    const entries = (Array.isArray(found.data) ? found.data : []) as Entry[]
    // Synced results first: a slightly worse match with timing beats an exact one without.
    const matchable = entries.map((entry) => ({ entry, title: entry.trackName, artists: [entry.artistName], duration: entry.duration }))
    const synced = matchable.filter((item) => item.entry.syncedLyrics)
    const winner = best(query, synced) ?? best(query, matchable)
    return winner ? toLyrics(winner.entry) : null
  },
}
