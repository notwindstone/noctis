/**
 * OpenSubsonic responses. Endpoints build a plain payload object; it's rendered as
 * JSON (`f=json`) or the default XML. (JSONP, a legacy way around CORS, isn't offered:
 * the API sends CORS headers.)
 *
 * XML from the JSON shape, the way Subsonic defines it: scalar fields become
 * attributes, arrays become repeated child elements, objects become child elements,
 * and a `value` field becomes text content (genres, lyrics).
 */

export const API_VERSION = '1.16.1'

export type Payload = Record<string, unknown>

export interface Envelope {
  status: 'ok' | 'failed'
  version: string
  type: string
  serverVersion: string
  openSubsonic: true
  [key: string]: unknown
}

export function envelope(serverVersion: string, payload: Payload, status: 'ok' | 'failed' = 'ok'): Envelope {
  return { status, version: API_VERSION, type: 'noctis', serverVersion, openSubsonic: true, ...payload }
}

/** Subsonic error codes. */
export const ERRORS = {
  generic: 0,
  missingParameter: 10,
  clientTooOld: 20,
  serverTooOld: 30,
  wrongCredentials: 40,
  tokenAuthUnsupported: 41,
  authMechanismUnsupported: 42,
  conflictingAuth: 43,
  invalidApiKey: 44,
  notAuthorized: 50,
  notFound: 70,
} as const

export class SubsonicError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)

// XML 1.0 forbids most control characters, even escaped.
const cleanXml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

function element(name: string, value: Record<string, unknown>): string {
  let attributes = ''
  let children = ''
  let text = ''
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined || field === null) continue
    if (key === 'value' && typeof field !== 'object') {
      text = escapeXml(cleanXml(String(field)))
    } else if (Array.isArray(field)) {
      for (const item of field) {
        children += typeof item === 'object' && item !== null ? element(key, item as Record<string, unknown>) : `<${key}>${escapeXml(cleanXml(String(item)))}</${key}>`
      }
    } else if (typeof field === 'object') {
      children += element(key, field as Record<string, unknown>)
    } else {
      attributes += ` ${key}="${escapeXml(cleanXml(String(field)))}"`
    }
  }
  const inner = children + text
  return inner ? `<${name}${attributes}>${inner}</${name}>` : `<${name}${attributes}/>`
}

export function toXml(body: Envelope): string {
  const { status, version, type, serverVersion, openSubsonic, ...payload } = body
  const root = element('subsonic-response', { status, version, type, serverVersion, openSubsonic, ...payload })
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root.replace('<subsonic-response', '<subsonic-response xmlns="http://subsonic.org/restapi"')}`
}

export function render(body: Envelope, format: string | undefined): Response {
  if (format === 'json') return Response.json({ 'subsonic-response': body })
  return new Response(toXml(body), { headers: { 'content-type': 'application/xml; charset=utf-8' } })
}
