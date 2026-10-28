import { finishTimes, parseMxmRichsync, parseMxmSubtitle } from '../parse'
import type { Line, LyricsSource, Query } from '../types'
import { settings } from '../state'
import { hasNativeHttp, http, similarity, cleanTitle } from '../util'

const APP = 'web-desktop-app-v1.0'
const BASE = 'https://apic-desktop.musixmatch.com/ws/1.1'
const HEADERS = { cookie: 'AWSELB=0; AWSELBCORS=0', authority: 'apic-desktop.musixmatch.com' }

interface Message<T = unknown> {
  header: { status_code: number }
  body: T
}

let token = ''

/** An anonymous token from Musixmatch's desktop-app endpoint, kept for later calls. */
async function getToken(fresh = false): Promise<string> {
  if (settings.musixmatchToken.trim()) return settings.musixmatchToken.trim()
  if (!fresh && token) return token
  const reply = await http(`${BASE}/token.get?app_id=${APP}`, { headers: HEADERS })
  const message = (reply.data as { message?: Message<{ user_token?: string }> })?.message
  const value = message?.body?.user_token
  if (!value || /^0+$/.test(value) || message?.header.status_code !== 200) throw new Error('Musixmatch refused an anonymous token (it often clears in a few minutes); you can add your own token in Settings → Lyrics')
  token = value
  return value
}

async function macro(query: Query, retry = true): Promise<Record<string, Message<any>> | null> {
  const user = await getToken(!retry)
  const params = new URLSearchParams({
    format: 'json',
    namespace: 'lyrics_richsynched',
    subtitle_format: 'mxm',
    app_id: APP,
    q_track: cleanTitle(query.title),
    q_artist: query.artists[0] ?? '',
    q_artists: query.artists.join(', '),
    q_album: query.album ?? '',
    q_duration: query.duration ? String(Math.round(query.duration)) : '',
    f_subtitle_length: query.duration ? String(Math.round(query.duration)) : '',
    f_subtitle_length_max_deviation: '3',
    usertoken: user,
  })
  const reply = await http(`${BASE}/macro.subtitles.get?${params}`, { headers: HEADERS })
  const message = (reply.data as { message?: Message<{ macro_calls?: Record<string, Message> }> })?.message
  // 401 with "captcha" means the token was throttled; one fresh token usually clears it.
  if (message && message.header.status_code === 401 && retry) {
    token = ''
    return macro(query, false)
  }
  return message?.body?.macro_calls ?? null
}

/**
 * Musixmatch, through the anonymous token its desktop app uses: word-by-word "richsync"
 * where it exists, line-synced otherwise. Unofficial, so it can stop working.
 */
export const musixmatch: LyricsSource = {
  id: 'musixmatch',
  name: 'Musixmatch',
  description: 'Word-synced lyrics for popular songs, like Apple Music. Unofficial; needs the app (not the browser).',
  native: true,

  async get(query: Query) {
    if (!hasNativeHttp()) throw new Error('Musixmatch blocks browsers (CORS); it works in the apps')
    const calls = await macro(query)
    if (!calls) return null

    // The matcher happily returns another song when it has no idea; check it.
    const track = calls['matcher.track.get']?.body?.track
    if (!track) return null
    const titleScore = similarity(cleanTitle(query.title), cleanTitle(String(track.track_name ?? '')))
    const artistScore = similarity(query.artists.join(' '), String(track.artist_name ?? ''))
    if (titleScore < 0.6 || (query.artists.length && artistScore < 0.4)) return null
    if (track.instrumental === 1) return { source: 'musixmatch', sourceName: 'Musixmatch', lines: [], sync: 'none', instrumental: true }

    let lines: Line[] = []
    let sync: 'word' | 'line' = 'line'
    const rich = calls['track.richsync.get']?.body?.richsync?.richsync_body
    if (typeof rich === 'string') {
      try {
        lines = parseMxmRichsync(rich)
        sync = 'word'
      } catch {
        lines = []
      }
    }
    if (lines.length === 0) {
      const body = calls['track.subtitles.get']?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body
      if (typeof body === 'string') {
        lines = parseMxmSubtitle(body)
        sync = 'line'
      }
    }
    if (lines.length === 0) return null
    return { source: 'musixmatch', sourceName: 'Musixmatch', lines: finishTimes(lines, query.duration), sync }
  },
}
