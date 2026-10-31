import { Noctis, type Album, type Artist, type ArtistRef, type Item, type Playlist, type Song } from './host'

/**
 * SoundCloud's own API (api-v2.soundcloud.com), the one its web app uses: a public
 * `client_id` read from the web app's scripts, plus `Authorization: OAuth <token>` once
 * signed in. Requests go through Noctis.libs.http: native HTTP on a device (the API only
 * allows soundcloud.com in CORS), the dev proxy in a browser.
 */

export const SOURCE = 'soundcloud'
const API = 'https://api-v2.soundcloud.com'
const WEB = 'https://soundcloud.com/'
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token'

const { http } = Noctis.libs

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Raw = Record<string, any>

/* ------------------------------------------------------------------ *
 * Session: the client id, and the signed-in token
 * ------------------------------------------------------------------ */

interface Storage {
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  remove(key: string): void
}

let storage: Storage
let clientId: { id: string; at: number } | null = null
const { ref } = Noctis.packages.vue

/**
 * The session, when signed in: SoundCloud's oauth_token cookie (a JWT that lasts an
 * hour) and, if we have it, oauth_refresh_token (months), which renews it the way
 * soundcloud.com's own server does.
 */
export interface Session {
  access: string
  refresh?: string
  /** From the JWT: when `access` expires (ms), and the client it was issued to. */
  expiresAt?: number
  clientId?: string
}

/** The access token, when signed in. */
export const token = ref<string | null>(null)
let session: Session | null = null
/** The signed-in user: { id, name, photo }. */
export const me = ref<{ id: number; name: string; photo?: string } | null>(null)

export function initSession(pluginStorage: Storage) {
  storage = pluginStorage
  clientId = storage.get('client-id', null) ?? null
  // Older versions kept only the token as a string.
  const stored = storage.get<Session | string | null>('token', null) ?? null
  session = typeof stored === 'string' ? sessionFrom(stored) : stored
  token.value = session?.access ?? null
  me.value = storage.get('me', null) ?? null
}

/** The JWT's claims (exp, client_id…), or null for older opaque tokens. */
function claimsOf(jwt: string): Raw | null {
  const payload = jwt.split('.')[1]
  if (!payload) return null
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')))
  } catch {
    return null
  }
}

export function sessionFrom(access: string, refresh?: string): Session {
  const claims = claimsOf(access)
  return {
    access,
    refresh: refresh || undefined,
    expiresAt: typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined,
    clientId: typeof claims?.client_id === 'string' ? claims.client_id : undefined,
  }
}

export function setSession(value: Session | null) {
  session = value
  token.value = value?.access ?? null
  if (value) storage.set('token', value)
  else storage.remove('token')
}

/** Whether the session can outlive its hour-long access token. */
export const canRenew = () => Boolean(session?.refresh)

let renewing: Promise<void> | null = null

/** A fresh access token from the refresh token, as soundcloud.com's server gets one. */
export function renewSession(): Promise<void> {
  const current = session
  if (!current?.refresh) return Promise.reject(new SoundCloudError('Your SoundCloud sign-in expired; sign in again', 401))
  renewing ??= (async () => {
    const response = await http.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json' },
      body: new URLSearchParams({ client_id: current.clientId ?? (await currentClientId()), grant_type: 'refresh_token', refresh_token: current.refresh! }).toString(),
    })
    const body = response.data as Raw
    if (response.status !== 200 || !body?.access_token) {
      // invalid_grant: the refresh token was revoked (signed out elsewhere) or rotated past.
      throw new SoundCloudError(`SoundCloud didn't renew the sign-in (${body?.error ?? `HTTP ${response.status}`}); sign in again`, 401)
    }
    setSession(sessionFrom(body.access_token, body.refresh_token ?? current.refresh))
  })().finally(() => {
    renewing = null
  })
  return renewing
}

export function setMe(value: { id: number; name: string; photo?: string } | null) {
  me.value = value
  if (value) storage.set('me', value)
  else storage.remove('me')
}

let discovering: Promise<string> | null = null

/** The web app's client id: in one of the scripts soundcloud.com loads (usually the last). */
async function discoverClientId(): Promise<string> {
  const page = await http.request(WEB, { headers: { accept: 'text/html' } })
  const html = String(page.data ?? '')
  const inline = /client_id[:=]"([A-Za-z0-9]{32})"/.exec(html)?.[1]
  if (inline) return inline
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((match) => match[1]).reverse()
  for (const script of scripts) {
    const body = String((await http.request(script)).data ?? '')
    const found = /client_id:"([A-Za-z0-9]{32})"/.exec(body)?.[1]
    if (found) return found
  }
  throw new Error("Couldn't find SoundCloud's client id; it may have changed its web app")
}

async function currentClientId(refresh = false): Promise<string> {
  if (!refresh && clientId && Date.now() - clientId.at < 7 * 24 * 3600_000) return clientId.id
  discovering ??= discoverClientId()
    .then((id) => {
      clientId = { id, at: Date.now() }
      storage.set('client-id', clientId)
      return id
    })
    .finally(() => {
      discovering = null
    })
  return discovering
}

export class SoundCloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** GET (or another method on) an API path or a full api-v2 URL (a `next_href`). */
export async function api<T = Raw>(path: string, params: Record<string, string | number | undefined> = {}, init: { method?: string; retried?: boolean } = {}): Promise<T> {
  // Renew a minute early rather than have a request bounce.
  if (session?.refresh && session.expiresAt && session.expiresAt - Date.now() < 60_000) await renewSession().catch(() => {})
  const url = new URL(path.startsWith('https://') ? path : `${API}${path}`)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
  // A signed-in token belongs to one client (its JWT says which); the API wants that one.
  url.searchParams.set('client_id', session?.clientId ?? (await currentClientId()))
  const headers: Record<string, string> = { accept: 'application/json' }
  if (session) headers.authorization = `OAuth ${session.access}`
  const response = await http.request(url.href, { method: init.method ?? 'GET', headers })
  if (response.status === 401 || response.status === 403) {
    if (!init.retried) {
      if (session?.refresh) await renewSession()
      // Signed out, a stale public client id answers 401 too: read it again.
      else if (!session) await currentClientId(true)
      if (session?.refresh || !session) return api<T>(path, params, { ...init, retried: true })
    }
    if (session) {
      const expired = session.expiresAt !== undefined && session.expiresAt < Date.now()
      throw new SoundCloudError(expired ? 'Your SoundCloud token expired (they last an hour); sign in again, or paste oauth_refresh_token too' : 'SoundCloud refused the session; sign in again', response.status)
    }
  }
  if (response.status < 200 || response.status >= 300) throw new SoundCloudError(`SoundCloud answered HTTP ${response.status}`, response.status)
  return response.data as T
}

/* ------------------------------------------------------------------ *
 * SoundCloud → Noctis models
 * ------------------------------------------------------------------ */

/** Artwork at a size: sndcdn URLs end in -large (100px), -t300x300, -t500x500… */
export function artworkAt(url: string | null | undefined, size = 500): string | undefined {
  if (!url) return undefined
  const variant = size <= 100 ? 'large' : size <= 300 ? 't300x300' : 't500x500'
  return url.replace(/-(large|t\d+x\d+|crop|original|small|tiny|badge|mini)\.(jpg|png)$/, `-${variant}.$2`)
}

export const userId = (id: number | string) => `${SOURCE}:user:${id}`
export const trackId = (id: number | string) => `${SOURCE}:${id}`
export const playlistId = (id: number | string) => `${SOURCE}:playlist:${id}`
export const systemPlaylistId = (urn: string) => `${SOURCE}:system:${urn}`

/** The number in "soundcloud:123", "soundcloud:user:123"…; system playlists keep their urn. */
export function rawId(id: string): string {
  if (id.startsWith(`${SOURCE}:system:`)) return id.slice(`${SOURCE}:system:`.length)
  return id.split(':').pop() ?? id
}

function artistOf(track: Raw): ArtistRef[] {
  const user = track.user ?? {}
  const artist = track.publisher_metadata?.artist
  // Labels upload for artists; publisher metadata names the artist when it's set.
  if (artist && artist !== user.username) return [{ name: artist }, { id: userId(user.id), name: user.username }]
  return [{ id: user.id ? userId(user.id) : undefined, name: user.username ?? 'Unknown artist' }]
}

/** Item id → its soundcloud.com page, for "Copy link" (remembered as items are seen). */
const permalinks = new Map<string, string>()
export const permalinkOf = (id: string) => permalinks.get(id)

function remember<T extends { id: string }>(item: T, raw: Raw): T {
  if (typeof raw.permalink_url === 'string') {
    permalinks.set(item.id, raw.permalink_url)
    if (permalinks.size > 5000) permalinks.delete(permalinks.keys().next().value!)
  }
  return item
}

/** Go+ tracks: without a subscription only a 30-second preview plays. */
export const previews = new Set<string>()

/** Full tracks only: stubs (id, kind, policy) need fetching first. */
export const isFull = (track: Raw) => typeof track?.title === 'string'

export function toSong(track: Raw): Song {
  if (track.policy === 'SNIP') previews.add(trackId(track.id))
  return remember({
    type: 'song',
    source: SOURCE,
    id: trackId(track.id),
    title: track.title,
    artists: artistOf(track),
    // Go+ tracks play a 30-second preview without a subscription; their real length is full_duration.
    duration: Math.round((track.full_duration ?? track.duration ?? 0) / 1000) || undefined,
    thumbnail: artworkAt(track.artwork_url ?? track.user?.avatar_url),
    explicit: Boolean(track.publisher_metadata?.explicit),
  }, track)
}

export function toArtist(user: Raw): Artist {
  const followers = user.followers_count
  return remember({
    type: 'artist',
    source: SOURCE,
    id: userId(user.id),
    name: user.username,
    subtitle: typeof followers === 'number' ? `${compactNumber(followers)} followers` : undefined,
    thumbnail: artworkAt(user.avatar_url),
  } as Artist, user)
}

export function toCollection(playlist: Raw): Album | Playlist {
  if (playlist.kind === 'system-playlist') {
    return {
      type: 'playlist',
      source: SOURCE,
      id: systemPlaylistId(playlist.urn),
      title: playlist.title,
      subtitle: playlist.short_description || playlist.description || 'SoundCloud',
      thumbnail: artworkAt(playlist.artwork_url ?? playlist.calculated_artwork_url),
    }
  }
  const thumbnail = artworkAt(playlist.artwork_url ?? playlist.tracks?.find(isFull)?.artwork_url ?? playlist.user?.avatar_url)
  if (playlist.is_album) {
    return {
      type: 'album',
      source: SOURCE,
      id: playlistId(playlist.id),
      title: playlist.title,
      artists: [{ id: userId(playlist.user?.id), name: playlist.user?.username ?? '' }],
      year: playlist.release_date?.slice(0, 4) ?? playlist.created_at?.slice(0, 4),
      thumbnail,
      kind: playlist.set_type ? playlist.set_type[0].toUpperCase() + playlist.set_type.slice(1) : 'Album',
    }
  }
  return {
    type: 'playlist',
    source: SOURCE,
    id: playlistId(playlist.id),
    title: playlist.title,
    subtitle: [playlist.user?.username, playlist.track_count ? `${playlist.track_count} tracks` : ''].filter(Boolean).join(' • '),
    thumbnail,
  }
}

export function toItem(raw: Raw): Item | null {
  if (!raw) return null
  if (raw.kind === 'track' && isFull(raw)) return toSong(raw)
  if (raw.kind === 'user') return toArtist(raw)
  if (raw.kind === 'playlist' || raw.kind === 'system-playlist') return toCollection(raw)
  return null
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** Full tracks for ids, in order (the API takes 50 at a time). */
export async function tracksByIds(ids: (number | string)[]): Promise<Raw[]> {
  const result: Raw[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const tracks = await api<Raw[]>('/tracks', { ids: chunk.join(',') })
    const byId = new Map(tracks.map((track) => [String(track.id), track]))
    for (const id of chunk) {
      const track = byId.get(String(id))
      if (track) result.push(track)
    }
  }
  return result
}

/** A list's tracks with every stub filled in. */
export async function fullTracks(tracks: Raw[]): Promise<Raw[]> {
  const missing = tracks.filter((track) => !isFull(track)).map((track) => track.id)
  if (missing.length === 0) return tracks
  const fetched = new Map((await tracksByIds(missing)).map((track) => [String(track.id), track]))
  return tracks.map((track) => (isFull(track) ? track : fetched.get(String(track.id)))).filter(Boolean) as Raw[]
}
