import { Noctis, type Song, type StreamInfo } from './host'
import { playerInnertube } from './client'
import { DESKTOP_UA, proxiedUrl } from './http'
import { poTokenFor } from './potoken'

const { StreamError } = Noctis.libs.stream

export async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  const yt = await playerInnertube()
  const info = await yt.music.getInfo(song.id)

  const status = info.playability_status
  if (status && status.status !== 'OK') {
    throw new StreamError(status.reason || 'This song is not available.')
  }

  const format = info.chooseFormat({
    type: 'audio',
    quality: efficient ? 'bestefficiency' : 'best',
    format: 'any',
  })

  // Without a proof-of-origin token googlevideo serves only the first ~1 MB.
  const [deciphered, poToken] = await Promise.all([format.decipher(yt.session.player), poTokenFor(song.id)])
  const url = `${deciphered}&pot=${encodeURIComponent(poToken)}`

  const expires = info.streaming_data?.expires
  return {
    url,
    mimeType: format.mime_type,
    bitrate: format.average_bitrate ?? format.bitrate,
    contentLength: format.content_length,
    loudnessDb: format.loudness_db,
    expiresAt: expires instanceof Date ? expires.getTime() : Date.now() + 5 * 3600_000,
    // googlevideo has no CORS: downloads in the browser go through the dev proxy.
    fetchUrl: proxiedUrl(url),
    fetchHeaders: { 'user-agent': DESKTOP_UA },
  }
}
