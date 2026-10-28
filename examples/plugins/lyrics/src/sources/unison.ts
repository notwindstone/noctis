import { finishTimes, parseAny } from '../parse'
import type { LyricsSource, Query } from '../types'
import { cleanTitle, http } from '../util'

interface Entry {
  song: string
  artist: string
  lyrics?: string | null
  format?: string
  syncType?: string
  effectiveScore?: number
}

const BASE = 'https://unison.boidu.dev'

/** Unison: lyrics people submitted and voted on, found by title or by YouTube video id. */
export const unison: LyricsSource = {
  id: 'unison',
  name: 'Unison',
  description: 'Community-submitted lyrics. Small, but often has songs the others miss.',

  async get(query: Query) {
    const params = new URLSearchParams({ song: cleanTitle(query.title), artist: query.artists[0] ?? '', limit: '5' })
    if (query.album) params.set('album', query.album)
    if (query.duration) params.set('duration', String(Math.round(query.duration)))

    const search = await http(`${BASE}/lyrics/search?${params}`)
    let entry = ((search.data as { data?: Entry[] })?.data ?? []).filter((item) => item.lyrics?.trim()).sort((a, b) => (b.effectiveScore ?? 0) - (a.effectiveScore ?? 0))[0]

    // Songs from YouTube Music are keyed by video id there.
    const youtube = !query.song.source || query.song.source === 'youtube-music'
    if (!entry && youtube) {
      const byId = await http(`${BASE}/lyrics?v=${encodeURIComponent(query.song.id)}`)
      const found = (byId.data as { success?: boolean; data?: Entry })?.data
      if (found?.lyrics?.trim()) entry = found
    }
    if (!entry?.lyrics) return null

    const parsed = parseAny(entry.lyrics, entry.format === 'ttml' ? 'x.ttml' : '')
    if (parsed.lines.length === 0) return null
    return { source: 'unison', sourceName: 'Unison', lines: parsed.sync === 'none' ? parsed.lines : finishTimes(parsed.lines, query.duration), sync: parsed.sync }
  },
}
