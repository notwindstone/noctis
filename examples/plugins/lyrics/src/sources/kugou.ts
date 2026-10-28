import { dropCredits, finishTimes, parseLrc } from '../parse'
import type { LyricsSource, Query } from '../types'
import { best, cleanTitle, hasNativeHttp, http } from '../util'

interface SongInfo {
  hash: string
  songname: string
  singername: string
  duration: number
}

interface Candidate {
  id: string
  accesskey: string
  song: string
  singer: string
  duration: number
}

const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)))

/** KuGou: a big Chinese catalogue with line-synced lyrics, no account. */
export const kugou: LyricsSource = {
  id: 'kugou',
  name: 'KuGou',
  description: 'Line-synced lyrics, strong for Asian music. Needs the app (not the browser).',
  native: true,

  async get(query: Query) {
    if (!hasNativeHttp()) throw new Error('KuGou blocks browsers (CORS); it works in the apps')
    const keyword = `${cleanTitle(query.title)} - ${query.artists[0] ?? ''}`
    const search = await http(`https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword=${encodeURIComponent(keyword)}`)
    const infos = ((search.data as { data?: { info?: SongInfo[] } })?.data?.info ?? []).map((info) => ({
      info,
      title: info.songname,
      artists: info.singername.split(/[、,&]/).map((name) => name.trim()),
      duration: info.duration,
    }))
    const winner = best(query, infos)

    let candidate: Candidate | undefined
    if (winner) {
      const byHash = await http(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=${winner.info.hash}`)
      candidate = (byHash.data as { candidates?: Candidate[] })?.candidates?.[0]
    }
    if (!candidate) {
      const byKeyword = await http(
        `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}${query.duration ? `&duration=${Math.round(query.duration) * 1000}` : ''}`,
      )
      const list = ((byKeyword.data as { candidates?: Candidate[] })?.candidates ?? []).map((item) => ({ item, title: item.song, artists: [item.singer], duration: item.duration / 1000 }))
      candidate = best(query, list, 0.5)?.item
    }
    if (!candidate) return null

    const download = await http(`https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=${candidate.id}&accesskey=${candidate.accesskey}`)
    const content = (download.data as { content?: string })?.content
    if (!content) return null
    const lines = dropCredits(parseLrc(decode(content).replace(/^﻿/, '')), query.title)
    if (lines.length === 0) return null
    return { source: 'kugou', sourceName: 'KuGou', lines: finishTimes(lines, query.duration), sync: 'line' }
  },
}
