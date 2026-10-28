import { finishTimes, sortLines } from '../parse'
import type { Line, LyricsSource, Query, Word } from '../types'
import { best, cleanTitle, http } from '../util'

interface Syllable {
  time: number
  duration: number
  text: string
}

interface Entry {
  time: number
  duration: number
  text: string
  syllabus?: Syllable[]
  element?: { singer?: string }
}

interface Reply {
  type?: string
  lyrics?: Entry[]
  metadata?: { title?: string; agents?: Record<string, unknown> }
}

/** Mirrors of the same service, tried in turn (any of them may be down). */
const MIRRORS = ['https://lyricsplus.binimum.org', 'https://lyricsplus.prjktla.my.id', 'https://lyricsplus.atomix.one']

/**
 * YouLyPlus: word-by-word lyrics in the form Apple Music has them (times in milliseconds,
 * a singer per line for duets). A community service with several mirrors.
 */
export const youlyplus: LyricsSource = {
  id: 'youlyplus',
  name: 'YouLyPlus',
  description: 'Word-by-word lyrics from Apple Music, with duet singers. No account needed.',

  async get(query: Query) {
    const params = new URLSearchParams({ title: cleanTitle(query.title), artist: query.artists[0] ?? '' })
    if (query.album) params.set('album', query.album)
    if (query.duration) params.set('duration', String(Math.round(query.duration)))

    let data: Reply | null = null
    let failure = ''
    for (const mirror of MIRRORS) {
      try {
        const reply = await http(`${mirror}/v2/lyrics/get?${params}`, {}, 8000)
        if (reply.status === 200 && typeof reply.data === 'object' && Array.isArray((reply.data as Reply).lyrics)) {
          data = reply.data as Reply
          break
        }
        failure = `${mirror} answered ${reply.status}`
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    if (!data) {
      // Every mirror failing is an error; one that merely has no entry is "not found".
      if (failure && !/\b404\b/.test(failure)) throw new Error(failure)
      return null
    }
    const entries = data.lyrics ?? []
    if (entries.length === 0) return null
    // The service matches loosely; make sure it is the song we asked for.
    if (data.metadata?.title && !best(query, [{ title: data.metadata.title, artists: query.artists }], 0.5)) return null

    const singers = new Set(entries.map((entry) => entry.element?.singer).filter(Boolean))
    const duet = singers.size > 1
    const first = [...singers][0]
    const wordSynced = data.type === 'Word'

    const lines: Line[] = entries.map((entry) => {
      const words: Word[] | undefined =
        wordSynced && entry.syllabus?.length
          ? entry.syllabus.map((syllable) => ({ text: syllable.text, start: syllable.time / 1000, end: (syllable.time + syllable.duration) / 1000 }))
          : undefined
      const text = (words ? words.map((word) => word.text).join('') : entry.text).trim()
      return {
        start: entry.time / 1000,
        end: (entry.time + entry.duration) / 1000,
        text,
        words,
        agent: duet ? (entry.element?.singer === first ? 'left' : 'right') : undefined,
      }
    })
    return { source: 'youlyplus', sourceName: 'YouLyPlus', lines: finishTimes(sortLines(lines), query.duration), sync: words(lines) ? 'word' : 'line' }
  },
}

const words = (lines: Line[]) => lines.some((line) => line.words?.length)
