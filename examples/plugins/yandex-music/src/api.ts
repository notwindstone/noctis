import { Noctis, type Album, type Artist, type ArtistRef, type Item, type Playlist, type Song } from './host'

/**
 * Yandex Music's mobile API (api.music.yandex.net), the one the Android/iOS apps use.
 * Unofficial: no public API, so this talks to it the way the official apps do —
 * `X-Yandex-Music-Client` on every call, `Authorization: OAuth <token>` once signed in.
 * The API serves permissive CORS, so in a browser plain requests also work (through
 * Noctis.libs.http, which uses native HTTP on a device anyway).
 *
 * Sign-in: OAuth Device Flow with the Android Music app's public client credentials —
 * the user opens oauth.yandex.ru/device, enters the code, and we poll for the token.
 * In a browser (CORS/WebView constraints) pasting a token is the fallback.
 */

export const SOURCE = 'yandex-music'
const API = 'https://api.music.yandex.net'
const OAUTH = 'https://oauth.yandex.ru'
/** Public OAuth credentials of the official Yandex Music Android app. */
const OAUTH_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d'
const OAUTH_CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300'
export const DEFAULT_DEVICE_NAME = 'Noctis'
/** What the official Android app sends; the API answers 4xx to unknown clients. */
const CLIENT_HEADER = 'YandexMusicAndroid/24023231'

const { http } = Noctis.libs

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Raw = Record<string, any>

interface Storage {
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  remove(key: string): void
}

const { ref } = Noctis.packages.vue

export const token = ref<string | null>(null)
/** What Yandex lists as the signing-in device; changeable in settings. */
export const deviceName = ref(DEFAULT_DEVICE_NAME)
export const me = ref<{ uid: number; name: string; login: string; plus?: boolean } | null>(null)

let storage: Storage

export function initSession(pluginStorage: Storage) {
  storage = pluginStorage
  token.value = storage.get('token', null) ?? null
  me.value = storage.get('me', null) ?? null
  deviceName.value = storage.get('device-name', DEFAULT_DEVICE_NAME) || DEFAULT_DEVICE_NAME
}

export function setDeviceName(value: string) {
  const name = value.trim()
  deviceName.value = name || DEFAULT_DEVICE_NAME
  if (name) storage.set('device-name', name)
  else storage.remove('device-name')
}

export function setSession(value: string | null) {
  token.value = value
  if (value) storage.set('token', value)
  else storage.remove('token')
}

export function setMe(value: { uid: number; name: string; login: string; plus?: boolean } | null) {
  me.value = value
  if (value) storage.set('me', value)
  else storage.remove('me')
}

/** The signed-in user from /account/status; keeps the last known one on failure. */
export async function refreshProfile() {
  if (!token.value) return null
  const status = await api<Raw>(`/account/status`)
  const account = status?.account ?? {}
  if (!account.uid) throw new YandexError('Yandex Music did not recognise this token; sign in again', 401)
  setMe({ uid: Number(account.uid), name: account.displayName ?? account.login ?? 'You', login: account.login ?? '', plus: Boolean(status.plus?.hasPlus) })
  return me.value
}

export class YandexError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function unwrap<T>(data: unknown): T {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'result' in (data as Raw) && (data as Raw).result !== undefined) {
    return (data as Raw).result as T
  }
  return data as T
}

/** GET (or another method on) an API path, with the client headers the apps send. */
export async function api<T = Raw>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  const url = new URL(path.startsWith('https://') ? path : `${API}${path}`)
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  const headers: Record<string, string> = {
    'x-yandex-music-client': CLIENT_HEADER,
    'user-agent': 'Yandex-Music-API',
    accept: 'application/json',
    ...(init.headers ?? {}),
  }
  if (token.value) headers.authorization = `OAuth ${token.value}`
  const response = await http.request(url.href, { method: init.method ?? 'GET', headers, body: init.body })
  const error = (response.data as Raw | null)?.error
  if (response.status === 451 || error?.name === 'Unavailable For Legal Reasons') {
    throw new YandexError('Yandex Music is not available from your region', 451)
  }
  if (response.status === 401 || response.status === 403) {
    throw new YandexError('Yandex Music rejected the session; sign in again', response.status)
  }
  if (response.status >= 300 || error) {
    throw new YandexError(error?.message || error?.name || `Yandex Music answered HTTP ${response.status}`, response.status)
  }
  return unwrap<T>(response.data)
}

/** POST with a form-urlencoded body (how the API takes list params and writes). */
export async function apiPost<T = Raw>(path: string, data: Record<string, string | number | undefined>): Promise<T> {
  const body = new URLSearchParams(
    Object.entries(data).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString()
  return api<T>(path, {}, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
}

/* ------------------------------------------------------------------ *
 * OAuth Device Flow (public creds of the official Android Music app)
 * ------------------------------------------------------------------ */

function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  interval: number
  expiresIn: number
}

/** A form POST to the OAuth server (no music-API headers, no token). */
async function oauthPost(path: string, data: Record<string, string>) {
  return http.request(`${OAUTH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(data).toString(),
  })
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await oauthPost('/device/code', { client_id: OAUTH_CLIENT_ID, device_id: randomId(), device_name: deviceName.value })
  const data = response.data as Raw
  if (response.status !== 200 || !data?.device_code || !data?.user_code) {
    throw new YandexError(data?.error_description || 'Yandex did not return a device code', response.status)
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url || 'https://ya.ru/device',
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 300,
  }
}

export type DevicePollResult = { status: 'pending' } | { status: 'ok'; token: string } | { status: 'failed'; error: string }

export async function pollDeviceToken(deviceCode: string): Promise<DevicePollResult> {
  const response = await oauthPost('/token', {
    grant_type: 'device_code',
    code: deviceCode,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  })
  const data = response.data as Raw
  if (response.status === 200 && data?.access_token) return { status: 'ok', token: data.access_token }
  const error = String(data?.error ?? '')
  if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' }
  return { status: 'failed', error: error || `HTTP ${response.status}` }
}

/* ------------------------------------------------------------------ *
 * Yandex Music → Noctis models
 * ------------------------------------------------------------------ */

/** Cover template with a %% size placeholder → a real URL at `size` px. */
export function coverUrl(uri: string | null | undefined, size = 400): string | undefined {
  if (!uri) return undefined
  if (/^https?:\/\//.test(uri)) return uri.replace(/%%/g, `${size}x${size}`)
  return `https://${uri.replace(/%%/g, `${size}x${size}`)}`
}

export const artistId = (id: number | string) => `${SOURCE}:artist:${id}`
export const albumId = (id: number | string) => `${SOURCE}:album:${id}`
export const playlistId = (uid: number | string, kind: number | string) => `${SOURCE}:playlist:${uid}:${kind}`

/** Strip the source and kind prefixes: "yandex-music:123:456" → "123:456", "yandex-music:album:7" → "7". */
export function rawId(id: string): string {
  const bare = id.startsWith(`${SOURCE}:`) ? id.slice(SOURCE.length + 1) : id
  return bare.replace(/^(album|artist|playlist):/, '')
}

/** The numeric track id from "yandex-music:123:456" → "123". */
export function numericTrackId(id: string): string {
  return rawId(id).split(':')[0]
}

function artistsOf(track: Raw): ArtistRef[] {
  const artists: ArtistRef[] = (track.artists ?? [])
    .filter((a: Raw) => a?.name)
    .map((a: Raw) => ({ id: a.id ? artistId(a.id) : undefined, name: a.name }))
  return artists.length > 0 ? artists : [{ name: 'Unknown artist' }]
}

function trackCover(track: Raw): string | undefined {
  const album = (track.albums ?? [])[0] ?? {}
  return coverUrl(album.cover?.uri ?? album.ogImage ?? track.coverUri ?? track.ogImage)
}

export const songIdOf = (track: Raw) => {
  const album = (track.albums ?? [])[0]
  return `${SOURCE}:${track.id}${album?.id !== undefined ? `:${album.id}` : ''}`
}

export function toSong(track: Raw): Song {
  const album = (track.albums ?? [])[0] ?? {}
  return {
    type: 'song',
    source: SOURCE,
    id: songIdOf(track),
    title: [track.title, track.version].filter(Boolean).join(' — '),
    artists: artistsOf(track),
    album: album.id ? { id: albumId(album.id), name: album.title ?? '' } : undefined,
    duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
    thumbnail: trackCover(track),
    explicit: track.explicit === true,
  }
}

export function toArtist(artist: Raw): Artist {
  return {
    type: 'artist',
    source: SOURCE,
    id: artistId(artist.id),
    name: artist.name ?? 'Unknown artist',
    thumbnail: coverUrl(artist.cover?.uri ?? artist.ogImage ?? artist.opImage),
  }
}

export function toAlbum(album: Raw): Album {
  return {
    type: 'album',
    source: SOURCE,
    id: albumId(album.id),
    title: album.title ?? 'Album',
    artists: (album.artists ?? []).filter((a: Raw) => a?.name).map((a: Raw) => ({ id: a.id ? artistId(a.id) : undefined, name: a.name })),
    year: album.year !== undefined && album.year !== null ? String(album.year) : undefined,
    thumbnail: coverUrl(album.cover?.uri ?? album.ogImage),
    kind: album.type ? album.type[0].toUpperCase() + album.type.slice(1) : 'Album',
  }
}

export function toPlaylist(playlist: Raw): Playlist {
  const owner = playlist.owner ?? {}
  return {
    type: 'playlist',
    source: SOURCE,
    id: playlistId(owner.uid ?? owner.id ?? '', playlist.kind),
    title: playlist.title ?? 'Playlist',
    subtitle: owner.login ?? undefined,
    thumbnail: coverUrl(playlist.cover?.uri ?? playlist.ogImage),
  }
}

export function toItem(raw: Raw): Item | null {
  if (!raw) return null
  if (raw.durationMs !== undefined && (raw.albums || raw.artists)) return toSong(raw)
  if (raw.owner && raw.kind !== undefined) return toPlaylist(raw)
  if (raw.trackCount !== undefined && raw.year !== undefined) return toAlbum(raw)
  if (raw.name) return toArtist(raw)
  return null
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** Short entries ({ id, albumId }) from whatever shape a list came in. */
export function asShorts(list: Raw[]): Short[] {
  const shorts: Short[] = []
  for (const entry of list ?? []) {
    const source = entry?.track ?? entry
    if (source?.id === undefined || source.id === null || source.id === '') continue
    const albumId = entry?.albumId ?? source.albums?.[0]?.id
    shorts.push({ id: String(source.id), albumId: albumId !== undefined && albumId !== null ? String(albumId) : undefined })
  }
  return shorts
}

export interface Short {
  id: string
  albumId?: string
}

/** Full tracks for { id, albumId } entries, in order (the API takes many at once). */
export async function fullTracks(shorts: Short[]): Promise<Raw[]> {
  const result: Raw[] = []
  for (let i = 0; i < shorts.length; i += 100) {
    const chunk = shorts.slice(i, i + 100)
    const tracks = await apiPost<Raw[]>('/tracks', { 'track-ids': chunk.map((s) => (s.albumId ? `${s.id}:${s.albumId}` : s.id)).join(',') })
    const byId = new Map<string, Raw>((tracks ?? []).map((track) => [String(track.id), track]))
    for (const short of chunk) {
      const track = byId.get(short.id)
      if (track) result.push(track)
    }
  }
  return result
}

/** A cover URL at the nearest size Yandex's CDN serves that isn't smaller than `size`. */
export function resizeCover(url: string, size: number): string | undefined {
  if (!/\/\d+x\d+$/.test(url)) return undefined
  const served = [50, 100, 200, 300, 400, 460, 600, 800, 1000]
  const best = served.find((value) => value >= size) ?? served[served.length - 1]
  return url.replace(/\d+x\d+$/, `${best}x${best}`)
}
