import { finishTimes, parseAny } from '../parse'
import { settings } from '../state'
import type { LyricsSource, Query } from '../types'
import { asText, cleanTitle, http } from '../util'

/** BetterLyrics (boidu.dev): Apple-style word-synced TTML, through an endpoint per catalogue. */
export const betterlyrics: LyricsSource = {
  id: 'betterlyrics',
  name: 'BetterLyrics',
  description: 'Word-by-word lyrics (TTML). Needs an API key from boidu.dev, added in settings; without one it is skipped.',

  async get(query: Query) {
    const key = settings.boiduKey.trim()
    if (!key) return null
    const params = new URLSearchParams({ s: cleanTitle(query.title), a: query.artists[0] ?? '' })
    if (query.album) params.set('al', query.album)
    if (query.duration) params.set('d', String(Math.round(query.duration)))

    let failure = ''
    // The main catalogue first, then the KuGou and QQ ones the same service proxies.
    for (const path of ['getLyrics', 'kugou/getLyrics', 'qq/getLyrics']) {
      const reply = await http(`https://lyrics-api.boidu.dev/${path}?${params}`, { headers: { 'x-api-key': key } })
      if (reply.status === 401 || reply.status === 403) throw new Error('BetterLyrics refused the API key')
      if (reply.status !== 200) {
        failure = `BetterLyrics answered ${reply.status}`
        continue
      }
      // Either TTML as it is, or JSON wrapping it.
      let body = asText(reply.data)
      if (typeof reply.data === 'object' && reply.data) {
        const wrapped = reply.data as { ttml?: string; lyrics?: string }
        body = wrapped.ttml ?? wrapped.lyrics ?? ''
      }
      if (!body.trim()) continue
      try {
        const parsed = parseAny(body, body.trimStart().startsWith('<') ? 'x.ttml' : '')
        if (parsed.lines.length === 0) continue
        return { source: 'betterlyrics', sourceName: 'BetterLyrics', lines: parsed.sync === 'none' ? parsed.lines : finishTimes(parsed.lines, query.duration), sync: parsed.sync }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    if (failure) throw new Error(failure)
    return null
  },
}

