import { parsePlain } from '../parse'
import type { LyricsSource, Query } from '../types'
import { asText, best, decodeEntities, hasNativeHttp, http, searchTerm } from '../util'

interface Hit {
  type: string
  result: { title: string; artist_names: string; url: string }
}

/** The index just past the `</div>` that closes the div opened at `from` (after its tag). */
function endOfDiv(html: string, from: number): number {
  let depth = 1
  const tag = /<(\/?)div\b[^>]*>/g
  tag.lastIndex = from
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[1] ? -1 : 1
    if (depth === 0) return t.index + t[0].length
  }
  return html.length
}

/** Cut out every div that matches `opening`, with what is inside it. */
function removeDivs(html: string, opening: RegExp): string {
  let out = ''
  let at = 0
  const open = new RegExp(opening.source, 'g')
  for (let m = open.exec(html); m; m = open.exec(html)) {
    if (m.index < at) continue
    out += html.slice(at, m.index)
    at = endOfDiv(html, m.index + m[0].length)
    open.lastIndex = at
  }
  return out + html.slice(at)
}

/** Pull the text out of Genius's lyric containers. */
export function extractGeniusLyrics(html: string): string {
  const parts: string[] = []
  const open = /<div[^>]*data-lyrics-container="true"[^>]*>/g
  for (let m = open.exec(html); m; m = open.exec(html)) {
    // Containers nest divs (the header, ads), so walk to the matching close.
    const end = endOfDiv(html, open.lastIndex)
    parts.push(html.slice(open.lastIndex, end - '</div>'.length))
    open.lastIndex = end
  }
  return decodeEntities(
    removeDivs(parts.join('\n'), /<div[^>]*data-exclude-from-selection="true"[^>]*>/)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Genius: no timing at all, but nearly every song. The last resort. */
export const genius: LyricsSource = {
  id: 'genius',
  name: 'Genius',
  description: 'Plain text without timing, for nearly every song. Needs the app (not the browser).',
  native: true,

  async get(query: Query) {
    if (!hasNativeHttp()) throw new Error('Genius blocks browsers (CORS); it works in the apps')
    const search = await http(`https://genius.com/api/search/multi?q=${encodeURIComponent(searchTerm(query))}`)
    const sections = ((search.data as { response?: { sections?: { hits: Hit[] }[] } })?.response?.sections ?? []) as { hits: Hit[] }[]
    const hits = sections.flatMap((section) => section.hits).filter((hit) => hit.type === 'song')
    const winner = best(
      query,
      hits.map((hit) => ({ hit, title: hit.result.title, artists: [hit.result.artist_names] })),
    )
    if (!winner) return null

    const page = await http(winner.hit.result.url)
    if (page.status !== 200) throw new Error(`Genius answered ${page.status}`)
    const text = extractGeniusLyrics(asText(page.data))
    if (!text) return null
    const lines = parsePlain(text).filter((line, index, all) => !(line.text === '' && (index === 0 || all[index - 1].text === '')))
    // "[Verse 1]" headers are for readers of the page, not singers.
    const sung = lines.filter((line) => !/^\[[^\]]+\]$/.test(line.text.trim()))
    return { source: 'genius', sourceName: 'Genius', lines: sung, sync: 'none' }
  },
}
