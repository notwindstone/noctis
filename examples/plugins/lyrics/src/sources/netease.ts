import { attachByTime, dropCredits, finishTimes, parseLrc, parseYrc } from '../parse'
import type { Lyrics, LyricsSource, Query } from '../types'
import { asText, best, hasNativeHttp, http, searchTerm } from '../util'

interface Song {
  id: number
  name: string
  dt: number
  ar: { name: string }[]
}

interface LyricReply {
  lrc?: { lyric?: string }
  yrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  ytlrc?: { lyric?: string }
  romalrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
}

const HEADERS = { referer: 'https://music.163.com/', 'content-type': 'application/x-www-form-urlencoded' }

/**
 * NetEase Cloud Music: a huge catalogue (J-pop, K-pop, C-pop, anime) with word-timed
 * lyrics (YRC), Chinese translations and, for Japanese, romaji.
 */
export const netease: LyricsSource = {
  id: 'netease',
  name: 'NetEase',
  description: 'Word-synced lyrics, translations and romaji for East Asian music. Needs the app (not the browser).',
  native: true,

  async get(query: Query) {
    if (!hasNativeHttp()) throw new Error('NetEase blocks browsers (CORS); it works in the apps')
    const search = await http('https://music.163.com/api/cloudsearch/pc', {
      method: 'POST',
      headers: HEADERS,
      body: `s=${encodeURIComponent(searchTerm(query))}&type=1&limit=10`,
    })
    const songs = ((search.data as { result?: { songs?: Song[] } })?.result?.songs ?? []).map((song) => ({
      song,
      title: song.name,
      artists: song.ar.map((artist) => artist.name),
      duration: song.dt / 1000,
    }))
    const winner = best(query, songs)
    if (!winner) return null

    const reply = await http(
      `https://music.163.com/api/song/lyric/v1?id=${winner.song.id}&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1`,
      { headers: { referer: 'https://music.163.com/' } },
    )
    if (reply.status !== 200 || typeof reply.data !== 'object') throw new Error(`NetEase answered ${reply.status}: ${asText(reply.data).slice(0, 80)}`)
    const data = reply.data as LyricReply

    const yrc = data.yrc?.lyric ? parseYrc(data.yrc.lyric) : []
    const lrc = data.lrc?.lyric ? parseLrc(data.lrc.lyric) : []
    const lines = dropCredits(yrc.length ? yrc : lrc)
    // "暂无歌词" ("no lyrics yet") is a placeholder, not a lyric.
    if (lines.length === 0 || (lines.length === 1 && /暂无歌词|纯音乐/.test(lines[0].text))) {
      return lines.length && /纯音乐/.test(lines[0].text) ? ({ source: 'netease', sourceName: 'NetEase', lines: [], sync: 'none', instrumental: true } satisfies Lyrics) : null
    }

    let translated = 0
    for (const text of [data.ytlrc?.lyric, data.tlyric?.lyric]) {
      if (!text) continue
      translated = attachByTime(lines, parseLrc(text), 'translation')
      if (translated) break
    }
    for (const text of [data.yromalrc?.lyric, data.romalrc?.lyric]) {
      if (text && attachByTime(lines, parseLrc(text), 'romanization')) break
    }

    return {
      source: 'netease',
      sourceName: 'NetEase',
      lines: finishTimes(lines, winner.duration),
      sync: yrc.length ? 'word' : 'line',
      // NetEase's own translations are Chinese, whatever the song's language.
      translationLang: translated ? 'zh' : undefined,
    }
  },
}
