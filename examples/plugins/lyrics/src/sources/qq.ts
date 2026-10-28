import { attachByTime, dropCredits, finishTimes, parseLrc } from '../parse'
import type { LyricsSource, Query } from '../types'
import { best, decodeEntities, hasNativeHttp, http, searchTerm } from '../util'

interface Song {
  songmid: string
  songname: string
  interval: number
  singer: { name: string }[]
}

const HEADERS = { referer: 'https://y.qq.com/' }

/** QQ Music: Chinese and Asian catalogue with line-synced lyrics and Chinese translations. */
export const qq: LyricsSource = {
  id: 'qq',
  name: 'QQ Music',
  description: 'Line-synced lyrics and translations, strong for Chinese music. Needs the app (not the browser).',
  native: true,

  async get(query: Query) {
    if (!hasNativeHttp()) throw new Error('QQ Music blocks browsers (CORS); it works in the apps')
    const search = await http(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(searchTerm(query))}&format=json&n=10&p=1`,
      { headers: HEADERS },
    )
    const list = ((search.data as { data?: { song?: { list?: Song[] } } })?.data?.song?.list ?? []).map((song) => ({
      song,
      title: decodeEntities(song.songname),
      artists: song.singer.map((singer) => decodeEntities(singer.name)),
      duration: song.interval,
    }))
    const winner = best(query, list)
    if (!winner) return null

    const reply = await http(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${winner.song.songmid}&format=json&nobase64=1`,
      { headers: HEADERS },
    )
    const data = reply.data as { lyric?: string; trans?: string }
    if (!data || typeof data !== 'object' || !data.lyric) return null
    const lines = dropCredits(parseLrc(decodeEntities(data.lyric)), query.title)
    if (lines.length === 0) return null
    let translated = 0
    if (data.trans) translated = attachByTime(lines, parseLrc(decodeEntities(data.trans)), 'translation')

    return {
      source: 'qq',
      sourceName: 'QQ Music',
      lines: finishTimes(lines, winner.duration),
      sync: 'line',
      translationLang: translated ? 'zh' : undefined,
    }
  },
}
