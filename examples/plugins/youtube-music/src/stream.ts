import { Noctis, type Song, type StreamInfo } from './host'
import { playerInnertube } from './client'
import { DESKTOP_UA, proxiedUrl } from './http'
import { poTokenFor } from './potoken'
import { coldStartToken, resolveSabr } from './sabr'

const { StreamError } = Noctis.libs.stream

export async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  const yt = await playerInnertube()
  const info = await yt.music.getInfo(song.id)

  const status = info.playability_status
  const basic = info.basic_info
  const formats = info.streaming_data?.adaptive_formats ?? []
  // Stations and live streams are where this goes wrong, so say everything we know about the video.
  Noctis.writeLog('youtube-music', 'info', `Stream for ${song.id} "${song.title}": playability ${status?.status ?? '?'}${status?.reason ? ` (${status.reason})` : ''}, live ${basic?.is_live ?? '?'}, live content ${basic?.is_live_content ?? '?'}, duration ${basic?.duration ?? '?'} s, ${formats.length} adaptive formats, HLS ${info.streaming_data?.hls_manifest_url ? 'yes' : 'no'}, DASH ${info.streaming_data?.dash_manifest_url ? 'yes' : 'no'}`)
  if (status && status.status !== 'OK') {
    throw new StreamError(status.reason || 'This song is not available.')
  }

  // Live streams and stations have no files to fetch: see sabr.ts.
  if (basic?.is_live) {
    // The streaming URL is only valid for SABR when the player request carried the cold-start token.
    const live = await yt.music.getInfo(song.id, { po_token: coldStartToken() })
    if (live.playability_status && live.playability_status.status !== 'OK') {
      throw new StreamError(live.playability_status.reason || 'This live stream is not available.')
    }
    return resolveSabr({ yt, info: live, videoId: song.id, efficient })
  }

  const format = info.chooseFormat({
    type: 'audio',
    quality: efficient ? 'bestefficiency' : 'best',
    format: 'any',
  })

  // Without a proof-of-origin token googlevideo serves only the first ~1 MB.
  const [deciphered, poToken] = await Promise.all([format.decipher(yt.session.player), poTokenFor(song.id)])
  const url = `${deciphered}&pot=${encodeURIComponent(poToken)}`

  Noctis.writeLog('youtube-music', 'info', `Chose itag ${format.itag} ${format.mime_type}, ${format.content_length ?? 'unknown'} bytes, approx ${format.approx_duration_ms ?? '?'} ms for ${song.id}`)

  const expires = info.streaming_data?.expires
  return {
    live: Boolean(basic?.is_live),
    duration: basic?.duration || (format.approx_duration_ms ? format.approx_duration_ms / 1000 : undefined),
    url,
    mimeType: format.mime_type,
    bitrate: format.average_bitrate ?? format.bitrate,
    sampleRate: Number(format.audio_sample_rate) || undefined,
    contentLength: format.content_length,
    loudnessDb: format.loudness_db,
    expiresAt: expires instanceof Date ? expires.getTime() : Date.now() + 5 * 3600_000,
    // googlevideo has no CORS: downloads in the browser go through the dev proxy.
    fetchUrl: proxiedUrl(url),
    fetchHeaders: { 'user-agent': DESKTOP_UA },
  }
}
