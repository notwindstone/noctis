import { CapacitorHttp } from '@capacitor/core'
import { isNative } from './native'

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  /** Parsed JSON when the response is JSON, text otherwise. */
  data: unknown
}

/** Hosts the dev server proxies (vite.config.ts) for requests the browser can't make. */
const PROXIED = /^https:\/\/(api-partner\.spotify\.com|clienttoken\.spotify\.com|open\.spotify\.com|open\.spotifycdn\.com|api-v2\.soundcloud\.com|secure\.soundcloud\.com|soundcloud\.com|a-v2\.sndcdn\.com|tracks\.monochrome\.st|monochrome\.st|monochrome-api\.samidy\.com)\//

/**
 * An HTTP request without CORS: Capacitor's native HTTP on a device; in the browser,
 * plain fetch (through the dev proxy for hosts that need it). For plugins talking to
 * services that don't allow cross-origin requests.
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

  const target = PROXIED.test(url) ? url.replace(/^https:\/\//, '/__yt/') : url
  const response = await fetch(target, { method, headers, body: body as string | undefined })
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

  const response = await fetch(url, { headers: { range } })
  // blob: and data: URLs ignore Range and answer 200 with everything.
  if (response.ok && response.status === 200 && !/^https?:/.test(url)) {
    const bytes = await response.arrayBuffer()
    return { status: 206, bytes: bytes.slice(start, end + 1) }
  }
  return { status: response.status, bytes: response.ok ? await response.arrayBuffer() : undefined }
}
