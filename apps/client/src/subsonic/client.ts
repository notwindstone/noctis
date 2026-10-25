import { request as httpRequest } from '../http'
import { serverUrl } from '../server'
import { persisted } from '../storage'

/**
 * An OpenSubsonic client (https://opensubsonic.netlify.app) for the connected server:
 * a Noctis server, or any other OpenSubsonic server that supports API keys
 * (apiKeyAuthentication). Legacy Subsonic auth (passwords in URLs, or md5 tokens made
 * from them) isn't supported, so no password is ever stored or sent after sign-in.
 */

export interface Credentials {
  username: string
  /** A Noctis session token, or an API key the server issued. */
  apiKey: string
}

const isCredentials = (value: unknown) =>
  value === null || (typeof value === 'object' && typeof (value as Credentials).apiKey === 'string' && !('password' in (value as object)))

/** Older versions could keep a password here; those are dropped (sign in again). */
export const credentials = persisted<Credentials | null>('noctis:subsonic-credentials', null, isCredentials)
// Don't leave an old password behind in storage.
if (localStorage.getItem('noctis:subsonic-credentials')?.includes('"password"')) localStorage.removeItem('noctis:subsonic-credentials')

const CLIENT = 'noctis'
const VERSION = '1.16.1'

export class SubsonicError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function authParams(auth = credentials.value): Record<string, string> {
  if (!auth) throw new SubsonicError(10, 'Not signed in to the server')
  return { apiKey: auth.apiKey }
}

/** A /rest URL with auth and the given parameters (repeat a key by passing an array). */
export function restUrl(endpoint: string, params: Record<string, string | number | string[] | undefined> = {}, auth = credentials.value): string {
  const url = new URL(`${serverUrl.value}/rest/${endpoint}`)
  for (const [key, value] of Object.entries({ v: VERSION, c: CLIENT, ...authParams(auth), ...params })) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
  }
  return url.href
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SubsonicPayload = Record<string, any>

/** Call an endpoint; resolves to the "subsonic-response" payload, or throws SubsonicError. */
export async function subsonic(endpoint: string, params: Record<string, string | number | string[] | undefined> = {}, auth = credentials.value): Promise<SubsonicPayload> {
  const response = await httpRequest(restUrl(endpoint, { ...params, f: 'json' }, auth))
  const body = (response.data as { 'subsonic-response'?: SubsonicPayload } | null)?.['subsonic-response']
  if (!body) throw new SubsonicError(0, `The server answered HTTP ${response.status}, not OpenSubsonic`)
  if (body.status !== 'ok') throw new SubsonicError(body.error?.code ?? 0, body.error?.message ?? 'The server refused the request')
  return body
}

/** Artwork URL for a coverArt id, at `size` px. */
export function coverUrl(id: string | undefined, size = 512): string | undefined {
  if (!id || !credentials.value || !serverUrl.value) return undefined
  return restUrl('getCoverArt', { id, size })
}

/** Audio URL for a song; `maxBitRate` asks the server for a smaller stream (if it transcodes). */
export function streamUrl(id: string, maxBitRate?: number): string {
  return restUrl('stream', { id, maxBitRate })
}

/** Whether the server offers an OpenSubsonic extension. */
export async function hasExtension(name: string): Promise<boolean> {
  try {
    const body = await subsonic('getOpenSubsonicExtensions')
    return (body.openSubsonicExtensions ?? []).some((extension: { name: string }) => extension.name === name)
  } catch {
    return false
  }
}
