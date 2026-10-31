import type { ServerHooks } from '../plugins/hooks'
import type { Catalog, SongRow, SourceRow } from './catalog'
import type { Providers } from './providers'

/**
 * Turning catalog entries into bytes: audio (with Range support, so clients can seek)
 * and artwork. Providers return a Response or a URL; URLs are fetched and relayed, so
 * clients only ever talk to this server.
 */

export class MediaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Artwork read recently, by its reference. Providers can be slow to produce one (the
 * local library parses the audio file for its embedded picture: 1.5–2.5 s a cover), and
 * every list asks for the same few again and again, at several sizes.
 */
const COVER_CACHE_BYTES = 48 * 1024 * 1024
const coverCache = new Map<string, { bytes: Uint8Array; type: string }>()
let coverCacheSize = 0

function rememberCover(reference: string, bytes: Uint8Array, type: string) {
  if (bytes.byteLength > COVER_CACHE_BYTES / 8) return
  coverCache.set(reference, { bytes, type })
  coverCacheSize += bytes.byteLength
  // Oldest first (a Map keeps insertion order; hits are moved to the end).
  for (const [key, entry] of coverCache) {
    if (coverCacheSize <= COVER_CACHE_BYTES) break
    coverCache.delete(key)
    coverCacheSize -= entry.bytes.byteLength
  }
}

const RELAYED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

async function relay(url: string, range?: string): Promise<Response> {
  if (!/^https?:\/\//i.test(url)) throw new MediaError(502, 'The provider returned an unusable URL')
  const upstream = await fetch(url, { headers: range ? { range } : {}, redirect: 'follow' })
  if (!upstream.ok && upstream.status !== 206) throw new MediaError(502, `The provider's audio answered HTTP ${upstream.status}`)
  const headers = new Headers()
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

/** Apply a Range header to a full-body Response from a provider (e.g. a local file). */
async function withRange(response: Response, range: string | undefined): Promise<Response> {
  if (!range || response.status !== 200) return response
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!match) return response
  const blob = await response.blob()
  const size = blob.size
  let start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
  let end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2])
  start = Math.max(0, start)
  end = Math.min(size - 1, end)
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    },
  })
}

export class Media {
  constructor(
    private readonly catalog: Catalog,
    private readonly providers: Providers,
    private readonly hooks: ServerHooks,
  ) {}

  /** Sources of a song the server itself can stream (their provider can stream), best first. */
  async streamable(songId: string): Promise<SourceRow[]> {
    return (await this.catalog.sources(songId)).filter((source) => this.providers.get(source.provider)?.stream)
  }

  /**
   * Stream a song: its best source, or `only` (a "provider:externalId" a Noctis client
   * picked with "Play from"). Falls through to the next source when one fails.
   */
  async stream(song: SongRow, options: { range?: string; maxBitRate?: number; user?: number; only?: string } = {}): Promise<Response> {
    let sources = await this.streamable(song.id)
    if (options.only) {
      sources = sources.filter((source) => `${source.provider}:${source.external_id}` === options.only)
      if (sources.length === 0) throw new MediaError(404, 'This server can\'t stream that source')
    }
    // Plugins may serve the audio themselves, or pick a different source.
    const hooked = await this.hooks.runBefore<Response>('onStream', { song, sources, user: options.user, range: options.range })
    if (hooked.stopped) return hooked.response
    if (sources.length === 0) throw new MediaError(404, 'No provider on this server can play this song')

    let lastError: unknown
    for (const source of sources) {
      try {
        const result = await this.providers.get(source.provider)!.stream!({ song, source, range: options.range, maxBitRate: options.maxBitRate })
        const response = typeof result === 'string' ? await relay(result, options.range) : await withRange(result, options.range)
        const headers = new Headers(response.headers)
        headers.set('accept-ranges', 'bytes')
        if (!headers.has('content-type') && source.content_type) headers.set('content-type', source.content_type)
        return new Response(response.body, { status: response.status, headers })
      } catch (error) {
        lastError = error // try the next source
      }
    }
    throw lastError instanceof MediaError ? lastError : new MediaError(502, lastError instanceof Error ? lastError.message : 'No source could be played')
  }

  async cover(id: string): Promise<Response> {
    const reference = await this.catalog.coverOf(id)
    if (!reference) throw new MediaError(404, 'No artwork')
    const cached = coverCache.get(reference)
    if (cached) {
      coverCache.delete(reference)
      coverCache.set(reference, cached)
      return new Response(cached.bytes, { headers: { 'content-type': cached.type, 'cache-control': 'public, max-age=86400' } })
    }
    let result: Response | string | null = reference
    if (!/^https?:\/\//i.test(reference)) {
      const provider = this.providers.get(reference.slice(0, reference.indexOf(':')))
      result = provider?.cover ? await provider.cover(reference) : null
    }
    if (!result) throw new MediaError(404, 'No artwork')
    const response = typeof result === 'string' ? await relay(result) : result
    const headers = new Headers(response.headers)
    headers.set('cache-control', 'public, max-age=86400')
    if (!response.ok) return new Response(response.body, { status: response.status, headers })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const type = headers.get('content-type') ?? 'image/jpeg'
    rememberCover(reference, bytes, type)
    return new Response(bytes, { status: response.status, headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' } })
  }
}
