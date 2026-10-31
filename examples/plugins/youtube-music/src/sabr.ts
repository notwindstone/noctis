import { SabrStream } from 'googlevideo/sabr-stream'
import { buildSabrFormat } from 'googlevideo/utils'
import { createColdStartToken } from 'bgutils-js/webpo'
import type { Innertube } from 'youtubei.js'
import { Noctis, type StreamInfo } from './host'
import { DESKTOP_UA, ytFetch } from './http'
import { poTokenBytesFor } from './potoken'

/**
 * Live streams and stations. The web player gets them over SABR: it POSTs what it has
 * buffered to googlevideo and the answer is audio segments in YouTube's own container
 * (UMP) — no manifest, no segment URLs, nothing an <audio> element could load. The
 * `googlevideo` package speaks the protocol; its audio comes out as fragmented MP4, which
 * is appended to a MediaSource and played from a blob: URL.
 *
 * Worth knowing, each of these was a 403 before it was fixed:
 * - the `n` parameter of the streaming URL has to be deciphered (youtubei.js leaves it);
 * - the player request carries a cold-start proof-of-origin token (the web player's own:
 *   an empty content binding), which is what makes the URL valid for SABR.
 */

const { StreamError } = Noctis.libs.stream

/** The Music web client's version the SABR request announces (clientName 67 is WEB_REMIX). */
const CLIENT_VERSION = '1.20261027.10.00'
const FIRST_DATA_TIMEOUT = 20_000
const UNUSED_TIMEOUT = 30_000
/** Played audio kept behind the playhead; the rest is dropped so a station can run all day. */
const KEEP_BEHIND = 60
const MAX_BUFFERED = 180

export const coldStartToken = () => createColdStartToken('')

/** Request headers googlevideo expects from the web client; the rest comes from the SABR package. */
function sabrFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return ytFetch(input, { ...init, headers: { 'user-agent': DESKTOP_UA, ...(init?.headers as Record<string, string> | undefined) } })
}

/** Everything the loop hands to a SourceBuffer, one append at a time. */
class Appender {
  private queue: Uint8Array[] = []
  private buffer: SourceBuffer | null = null
  private busy = false

  constructor(private readonly audio: () => HTMLMediaElement | null) {}

  attach(buffer: SourceBuffer) {
    this.buffer = buffer
    buffer.addEventListener('updateend', () => {
      this.busy = false
      this.pump()
    })
    this.pump()
  }

  push(chunk: Uint8Array) {
    this.queue.push(chunk)
    this.pump()
  }

  private trim(buffer: SourceBuffer, force: boolean) {
    const ranges = buffer.buffered
    if (ranges.length === 0) return false
    const start = ranges.start(0)
    const end = ranges.end(ranges.length - 1)
    const played = this.audio()?.currentTime ?? 0
    // Nothing is dropped that hasn't been played, except when the buffer won't take more.
    const limit = force ? Math.min(played, end - 10) : Math.min(played - KEEP_BEHIND, end - MAX_BUFFERED)
    if (limit <= start) return false
    buffer.remove(start, limit)
    this.busy = true
    return true
  }

  private pump() {
    const buffer = this.buffer
    if (!buffer || this.busy || buffer.updating || this.queue.length === 0) return
    if (this.trim(buffer, false)) return
    const chunk = this.queue[0]
    try {
      buffer.appendBuffer(chunk as BufferSource)
      this.queue.shift()
      this.busy = true
    } catch (error) {
      if ((error as DOMException).name === 'QuotaExceededError' && this.trim(buffer, true)) return
      throw error
    }
  }
}

export async function resolveSabr({ yt, info, videoId, efficient }: { yt: Innertube; info: any; videoId: string; efficient: boolean }): Promise<StreamInfo> {
  const data = info.streaming_data
  const serverUrl = data?.server_abr_streaming_url as string | undefined
  const ustreamer = info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config as string | undefined
  if (!serverUrl || !ustreamer) throw new StreamError("YouTube didn't offer this live stream to the app")

  const stream = new SabrStream({
    videoId,
    // youtubei.js leaves `n` as it came; the server refuses the request with a 403 unless it is deciphered.
    serverAbrStreamingUrl: await yt.session.player!.decipher(serverUrl),
    videoPlaybackUstreamerConfig: ustreamer,
    clientInfo: { clientName: 67, clientVersion: CLIENT_VERSION },
    formats: (data.adaptive_formats as any[]).map((format) => buildSabrFormat(format)),
    poToken: coldStartToken(),
    fetchFunction: sabrFetch,
    // Once the cold-start token runs out (about 50 s in) the server wants a full one, bound to the video.
    callbacks: { onMintPoToken: () => poTokenBytesFor(videoId) },
  })

  const { audioStream, selectedFormats } = stream.start({
    audioFormat: (formats) => {
      const mp4 = formats.filter((format) => format.mimeType?.startsWith('audio/mp4')).sort((a, b) => a.bitrate - b.bitrate)
      return efficient ? mp4[0] : mp4.at(-1)
    },
    enabledTrackTypes: 1,
    isPostLiveDvr: false,
  })
  const audioFormat = selectedFormats.audioFormat
  const mimeType = audioFormat.mimeType?.replace(/;\s*codecs="([^"]+)"/, '; codecs="$1"') ?? 'audio/mp4; codecs="mp4a.40.2"'
  if (!MediaSource.isTypeSupported(mimeType)) {
    await stream.abort().catch(() => {})
    throw new StreamError("This device can't play YouTube's live audio format")
  }

  const source = new MediaSource()
  const url = URL.createObjectURL(source)
  let media: HTMLMediaElement | null = null
  const appender = new Appender(() => media)
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    void stream.abort().catch(() => {})
    URL.revokeObjectURL(url)
  }
  stream.on('error', (error) => {
    Noctis.writeLog('youtube-music', 'warn', `SABR stream for ${videoId}: ${error.message}`)
  })

  source.addEventListener('sourceopen', () => {
    if (closed || source.sourceBuffers.length > 0) return
    try {
      source.duration = Infinity
    } catch {
      /* the element sets it itself */
    }
    const buffer = source.addSourceBuffer(mimeType)
    // A live stream's segments carry absolute timestamps (days of them); in sequence mode they are played back to back from 0.
    buffer.mode = 'sequence'
    appender.attach(buffer)
  })
  // Another song replaced this one in the element (or the player stopped): nothing needs the stream any more.
  source.addEventListener('sourceclose', close)
  source.addEventListener('sourceended', close)

  // The first chunk is the proof that it works; without it the song can fall back to another source.
  const reader = audioStream.getReader()
  const first = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), FIRST_DATA_TIMEOUT)),
  ])
  if (!first || first.done) {
    close()
    throw new StreamError(first ? 'The live stream ended' : "The live stream didn't start")
  }
  const toBytes = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  appender.push(toBytes(first.value))
  // Resolved but never played (the app resolves a song again to save it): nothing would ever close it.
  window.setTimeout(() => {
    if (source.readyState === 'closed') close()
  }, UNUSED_TIMEOUT)
  Noctis.writeLog('youtube-music', 'info', `SABR live audio for ${videoId}: itag ${audioFormat.itag}, ${mimeType}`)

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || closed) break
        appender.push(toBytes(value))
      }
    } catch (error) {
      Noctis.writeLog('youtube-music', 'warn', `SABR stream for ${videoId} stopped: ${(error as Error).message}`)
    }
  })()

  // Where the playhead is decides what may be trimmed from the buffer.
  media = Noctis.libs.player.audioElement

  return {
    live: true,
    url,
    mimeType: 'audio/mp4',
    bitrate: audioFormat.averageBitrate ?? audioFormat.bitrate,
    // Never kept by the app (inside its 20-minute margin): the MediaSource lives with this one playback.
    expiresAt: Date.now() + 10 * 60_000,
  }
}
