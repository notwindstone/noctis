import { ref } from 'vue'
import { request as httpRequest } from '../http'
import { serverUrl } from '../server'
import { md5 } from '../md5'
import { persisted } from '../storage'

/**
 * An OpenSubsonic client (https://opensubsonic.netlify.app) for the connected server:
 * a Noctis server, or any other OpenSubsonic or Subsonic server.
 *
 * - API keys (apiKeyAuthentication) come first: a Noctis session token, or a key the
 *   server issued.
 * - Servers without them (Navidrome's demo, older ones) get Subsonic's token auth:
 *   u, t = md5(password + salt), s. One salt is kept with its token, so the password
 *   itself is never stored or sent. Plain `p=` passwords are never used.
 */

export type Credentials =
  | {
      username: string
      /** A Noctis session token, or an API key the server issued. */
      apiKey: string
    }
  | {
      username: string
      /** md5(password + salt): legacy Subsonic token auth. */
      token: string
      salt: string
    }

const isCredentials = (value: unknown) =>
  value === null ||
  (typeof value === 'object' &&
    !('password' in (value as object)) &&
    (typeof (value as { apiKey?: unknown }).apiKey === 'string' || (typeof (value as { token?: unknown }).token === 'string' && typeof (value as { salt?: unknown }).salt === 'string')))

/** Older versions could keep a password here; those are dropped (sign in again). */
export const credentials = persisted<Credentials | null>('noctis:subsonic-credentials', null, isCredentials)
// Don't leave an old password behind in storage.
if (localStorage.getItem('noctis:subsonic-credentials')?.includes('"password"')) localStorage.removeItem('noctis:subsonic-credentials')

/**
 * The server lets anyone in without an account (a Noctis server with guest access,
 * NOCTIS_GUEST_ACCESS): requests without credentials act as its "guests" group.
 */
export const guestAccess = persisted('noctis:server-guest-access', false, (value) => typeof value === 'boolean')

/** Signed in, or a guest on a server that allows guests. */
export const canUseServer = () => credentials.value !== null || guestAccess.value

const CLIENT = 'noctis'
const VERSION = '1.16.1'

/**
 * Bumped when the server answers again after being unreachable: it's part of the account's
 * session key, so screens that failed refetch and cached pages from before are dropped.
 */
export const connectionEpoch = ref(0)

let onNetworkError: (() => void) | null = null
/** server.ts hears about requests that never got an answer, to start reconnecting. */
export function setNetworkErrorHandler(handler: () => void) {
  onNetworkError = handler
}

export class SubsonicError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function authParams(auth = credentials.value): Record<string, string> {
  if (!auth && guestAccess.value) return {}
  if (!auth) throw new SubsonicError(10, 'Not signed in to the server')
  if ('apiKey' in auth) return { apiKey: auth.apiKey }
  return { u: auth.username, t: auth.token, s: auth.salt }
}

/** Legacy credentials from a password: a fresh salt and its token; the password isn't kept. */
export function tokenCredentials(username: string, password: string): Credentials {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { username, token: md5(password + salt), salt }
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
  const response = await httpRequest(restUrl(endpoint, { ...params, f: 'json' }, auth)).catch((error) => {
    onNetworkError?.()
    throw error
  })
  const body = (response.data as { 'subsonic-response'?: SubsonicPayload } | null)?.['subsonic-response']
  if (!body && [502, 503, 504].includes(response.status)) onNetworkError?.()
  if (!body) throw new SubsonicError(0, `The server answered HTTP ${response.status}, not OpenSubsonic`)
  if (body.status !== 'ok') throw new SubsonicError(body.error?.code ?? 0, body.error?.message ?? 'The server refused the request')
  return body
}

/** Artwork URL for a coverArt id, at `size` px. */
export function coverUrl(id: string | undefined, size = 512): string | undefined {
  if (!id || !canUseServer() || !serverUrl.value) return undefined
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
