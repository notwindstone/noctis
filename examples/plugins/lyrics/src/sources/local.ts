import { finishTimes, parseAny } from '../parse'
import type { Lyrics, LyricsSource, Query } from '../types'
import { kv } from '../util'

/** Where a song's own lyrics file is kept. */
export const localKey = (songKey: string) => `local:${songKey}`

export interface LocalLyrics {
  fileName: string
  lines: Lyrics['lines']
  sync: Lyrics['sync']
}

/** Make lyrics out of a picked .lrc / .ttml / .srt / .txt file. */
export function readLocalFile(name: string, text: string, duration?: number): LocalLyrics {
  const parsed = parseAny(text, name)
  if (parsed.lines.length === 0) throw new Error(`No lyrics found in ${name}`)
  return { fileName: name, lines: parsed.sync === 'none' ? parsed.lines : finishTimes(parsed.lines, duration), sync: parsed.sync }
}

/** Lyrics the user attached to a song from a file; they beat every online source. */
export function localSource(keyOf: (query: Query) => string): LyricsSource {
  return {
    id: 'local',
    name: 'Your files',
    description: 'A .lrc, .ttml or .srt file you attached to a song (player → Lyrics → ⋮ → Use a file).',

    async get(query) {
      const stored = await kv.get<LocalLyrics>(localKey(keyOf(query)))
      if (!stored) return null
      return { source: 'local', sourceName: `File: ${stored.fileName}`, lines: stored.lines, sync: stored.sync }
    },
  }
}
