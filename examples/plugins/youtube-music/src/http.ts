import { CapacitorHttp } from '@capacitor/core'
import { Noctis } from './host'

/**
 * Network access for InnerTube.
 *
 * - On a device, requests go through Capacitor's native HTTP stack: no CORS, and
 *   headers such as Cookie, Origin and User-Agent are sent as given.
 * - On desktop, through the app's own HTTP client (Noctis.libs.http.nativeFetch): the
 *   same freedom, with a real fetch() to hand to youtubei.js.
 * - In the browser (development), they are rewritten to the Vite proxy in
 *   vite.config.ts. Headers the browser refuses to send are smuggled as
 *   `x-noctis-<name>` and restored by the proxy.
 */

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const { isNative, isDesktop } = Noctis.libs.native

const FORBIDDEN_HEADERS = ['cookie', 'origin', 'referer', 'user-agent']

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, name) => {
    result[name] = value
  })
  return result
}

export function proxiedUrl(url: string): string {
  return isNative || isDesktop ? url : url.replace(/^https:\/\//, '/__yt/')
}

/** Whether a URL can be fetched directly (native) or needs the dev proxy (browser). */
export function canProxy(url: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.googlevideo\.com|music\.youtube\.com|www\.youtube\.com|youtubei\.googleapis\.com|jnn-pa\.googleapis\.com)\//.test(url)
}

/** A fetch() for youtubei.js. */
export async function ytFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString()
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const headers = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  // Text for InnerTube; bytes for SABR (stream.ts), whose answers are bytes too.
  const bytesBody = init?.body instanceof Uint8Array ? init.body : init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined
  const body = typeof init?.body === 'string' ? init.body : bytesBody

  const host = new URL(url).host
  if (host.endsWith('youtube.com')) {
    headers['origin'] ??= `https://${host}`
    headers['referer'] ??= `https://${host}/`
  }

  if (isDesktop) {
    headers['user-agent'] ??= DESKTOP_UA
    return Noctis.libs.http.nativeFetch(url, { method, headers, body: body as BodyInit | undefined })
  }

  if (isNative) {
    headers['user-agent'] ??= DESKTOP_UA
    // Plain JSON is sent as an object; variants like application/json+protobuf as raw text.
    const isJson = /^application\/json(;|$)/.test(headers['content-type'] ?? '')
    if (bytesBody || /vnd\.yt-ump/.test(headers['accept'] ?? '')) {
      const response = await CapacitorHttp.request({
        url,
        method,
        headers,
        // Capacitor takes a binary body as base64 with dataType "file" and answers bytes as base64.
        data: bytesBody ? bytesToBase64(bytesBody) : undefined,
        dataType: bytesBody ? 'file' : undefined,
        responseType: 'arraybuffer',
      })
      const bytes = typeof response.data === 'string' && response.status !== 204 ? base64ToBytes(response.data) : null
      return new Response(bytes as BodyInit | null, { status: response.status, headers: response.headers })
    }
    const response = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body === undefined ? undefined : isJson ? JSON.parse(body as string) : body,
      responseType: 'text',
    })
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    return new Response(response.status === 204 ? null : text, {
      status: response.status,
      headers: response.headers,
    })
  }

  const browserHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    browserHeaders[FORBIDDEN_HEADERS.includes(name.toLowerCase()) ? `x-noctis-${name.toLowerCase()}` : name] = value
  }

  return fetch(proxiedUrl(url), { method, headers: browserHeaders, body: body as BodyInit | undefined })
}
