import { CapacitorHttp } from '@capacitor/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isDesktop, isNative } from './native'

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  /** Parsed JSON when the response is JSON, text otherwise. */
  data: unknown
}

/** Hosts the dev server proxies (vite.config.ts) for requests the browser can't make. */
const PROXIED = /^https:\/\/(api-partner\.spotify\.com|clienttoken\.spotify\.com|spclient\.wg\.spotify\.com|seektables\.spotifycdn\.com|open\.spotify\.com|open\.spotifycdn\.com|api-v2\.soundcloud\.com|secure\.soundcloud\.com|soundcloud\.com|a-v2\.sndcdn\.com|tracks\.monochrome\.st|monochrome\.st|monochrome-api\.samidy\.com|bandcamp\.com|[a-z0-9-]+\.bandcamp\.com|t4\.bcbits\.com|f4\.bcbits\.com)\//

/**
 * fetch() without CORS or forbidden headers (Cookie, Origin, User-Agent…) on desktop,
 * where the request is made by the app's Rust side; plain fetch elsewhere.
 */
export const nativeFetch: typeof fetch = (input, init) => (isDesktop ? tauriFetch(input, init) : fetch(input, init))

/**
 * An HTTP request without CORS: Capacitor's native HTTP on a device, the app's own HTTP
 * client on desktop; in the browser, plain fetch (through the dev proxy for hosts that
 * need it). For plugins talking to services that don't allow cross-origin requests.
 */
export async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResponse> {
  const method = init.method ?? 'GET'
  const headers = { ...(init.headers ?? {}) }
  const body = init.body === undefined || typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  if (init.body !== undefined && typeof init.body !== 'string') headers['content-type'] ??= 'application/json'

  if (isNative) {
    const isJson = /^application\/json/.test(headers['content-type'] ?? '')
    const response = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body === undefined ? undefined : isJson ? JSON.parse(body as string) : body,
      responseType: 'text',
    })
    let data: unknown = response.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        /* not JSON */
      }
    }
    return { status: response.status, headers: response.headers, data }
  }

  const target = proxied(url)
  const response = await nativeFetch(target, { method, headers, body: body as string | undefined })
  const text = await response.text()
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  const out: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    out[name] = value
  })
  return { status: response.status, headers: out, data }
}

/** In the browser, hosts the dev server proxies go through `/__yt/<host>/<path>`. */
function proxied(url: string): string {
  return !isDesktop && /^https:\/\//.test(url) && PROXIED.test(url) ? url.replace(/^https:\/\//, '/__yt/') : url
}

/**
 * A request whose body and answer are raw bytes, e.g. a DRM license exchange. The
 * response body isn't parsed or decoded; on desktop the request has no CORS limits, in
 * the browser it goes through the dev proxy like the rest.
 */
export async function requestBytes(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: ArrayBuffer | ArrayBufferView } = {},
): Promise<{ status: number; bytes: ArrayBuffer }> {
  const response = await nativeFetch(proxied(url), {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body as BodyInit | undefined,
  })
  return { status: response.status, bytes: response.ok ? await response.arrayBuffer() : new ArrayBuffer(0) }
}

/** Fetch a byte range of a media URL, e.g. one chunk of a download. */
export async function fetchRange(
  url: string,
  start: number,
  end: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; base64?: string; bytes?: ArrayBuffer }> {
  const range = `bytes=${start}-${end}`

  if (isNative && /^https?:/.test(url)) {
    const response = await CapacitorHttp.request({
      url,
      method: 'GET',
      headers: { ...headers, range },
      responseType: 'arraybuffer',
    })
    return { status: response.status, base64: typeof response.data === 'string' ? response.data : undefined }
  }

  const response = await nativeFetch(url, { headers: isDesktop && /^https?:/.test(url) ? { ...headers, range } : { range } })
  // blob: and data: URLs ignore Range and answer 200 with everything.
  if (response.ok && response.status === 200 && !/^https?:/.test(url)) {
    const bytes = await response.arrayBuffer()
    return { status: 206, bytes: bytes.slice(start, end + 1) }
  }
  return { status: response.status, bytes: response.ok ? await response.arrayBuffer() : undefined }
}
