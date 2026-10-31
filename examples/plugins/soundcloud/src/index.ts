import type { ArtistPage, CollectionPage, HomeResult, Item, PluginScope, QueuePage, RadioSeed, SearchResult, Section, ServiceDefinition, Song } from './host'
import { Noctis } from './host'
import {
  api,
  artworkAt,
  compactNumber,
  fullTracks,
  initSession,
  isFull,
  me,
  rawId,
  setMe,
  setSession,
  sessionFrom,
  renewSession,
  canRenew,
  type Session,
  SOURCE,
  toArtist,
  toCollection,
  toItem,
  token,
  toSong,
  permalinkOf,
  previews,
  type Raw,
} from './api'
import { resolveStream } from './stream'

/**
 * SoundCloud for Noctis: a service (home, search, artists, playlists, albums, radios,
 * your library) and a source for songs from elsewhere (Noctis.libs.matching).
 *
 * - Signed out, home is SoundCloud's own discovery: curated and trending selections.
 * - Signed in, home adds your feed and recently played, and the library has your likes,
 *   playlists and follows. Signing in happens on SoundCloud's own page (in the Android
 *   app's sign-in window); the session is the oauth_token cookie it sets. In a browser,
 *   that token can be pasted instead.
 *
 * Unofficial: SoundCloud closed its API to new apps, so this uses the web app's API
 * the way the web app does. It may break until the plugin is updated.
 */

const { computed } = Noctis.packages.vue
const { notify } = Noctis.libs.snackbar
const { confirm, showTextDialog } = Noctis.libs.ui
const { auth } = Noctis.libs

const signedIn = computed(() => Boolean(token.value))
const section = (id: string, title: string, items: (Item | null)[], layout: Section['layout'] = 'carousel', strapline?: string): Section[] => {
  const list = items.filter((item): item is Item => item !== null)
  return list.length > 0 ? [{ id, title, items: list, layout, strapline }] : []
}
const settled = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Home: SoundCloud's discovery, and your feed when signed in
 * ------------------------------------------------------------------ */

async function loadHome(): Promise<HomeResult> {
  const [selections, feed, recent] = await Promise.all([
    api<{ collection: Raw[] }>('/mixed-selections', { limit: 20 }),
    signedIn.value ? settled(api<{ collection: Raw[] }>('/stream', { limit: 30 })) : null,
    signedIn.value ? settled(api<{ collection: Raw[] }>('/me/play-history/tracks', { limit: 20 })) : null,
  ])
  const sections: Section[] = [
    ...section('feed', 'From people you follow', (feed?.collection ?? []).map((entry) => toItem(entry.track ?? entry.playlist)), 'quick-picks'),
    ...section('recent', 'Recently played', (recent?.collection ?? []).map((entry) => toItem(entry.track)), 'quick-picks'),
  ]
  for (const selection of selections.collection ?? []) {
    sections.push(...section(selection.urn ?? selection.id, selection.title, (selection.items?.collection ?? []).map(toItem), 'carousel', selection.description || undefined))
  }
  return { sections, filters: [], selectedFilter: null, hasMore: false }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const SEARCH_PATHS: Record<string, string> = {
  song: '/search/tracks',
  artist: '/search/users',
  album: '/search/albums',
  playlist: '/search/playlists_without_albums',
}

let searchNext: string | null = null

async function searchQuery({ query, type }: { query: string; type: string }): Promise<SearchResult> {
  if (type !== 'all') {
    const page = await api<{ collection: Raw[]; next_href?: string }>(SEARCH_PATHS[type] ?? '/search', { q: query, limit: 30 })
    searchNext = page.next_href ?? null
    return { sections: [], items: page.collection.map(toItem).filter((item): item is Item => item !== null), hasMore: Boolean(searchNext) }
  }
  const page = await api<{ collection: Raw[] }>('/search', { q: query, limit: 40 })
  const items = page.collection.map(toItem).filter((item): item is Item => item !== null)
  const [top] = items
  return {
    sections: [
      ...section('top', 'Top result', top ? [top] : [], 'list'),
      ...section('songs', 'Tracks', items.filter((item) => item.type === 'song' && item !== top).slice(0, 12), 'list'),
      ...section('artists', 'Artists', items.filter((item) => item.type === 'artist' && item !== top)),
      ...section('albums', 'Albums', items.filter((item) => item.type === 'album' && item !== top)),
      ...section('playlists', 'Playlists', items.filter((item) => item.type === 'playlist' && item !== top)),
    ],
    items: [],
    hasMore: false,
  }
}

async function searchMore(): Promise<{ items: Item[]; hasMore: boolean }> {
  if (!searchNext) return { items: [], hasMore: false }
  const page = await api<{ collection: Raw[]; next_href?: string }>(searchNext)
  searchNext = page.next_href ?? null
  return { items: page.collection.map(toItem).filter((item): item is Item => item !== null), hasMore: Boolean(searchNext) }
}

async function suggestions({ input }: { input: string }) {
  const page = await api<{ collection: { output: string }[] }>('/search/queries', { q: input, limit: 8 })
  return { queries: page.collection.map((entry) => entry.output), items: [] }
}

/* ------------------------------------------------------------------ *
 * Playlists, albums and system playlists (charts, "trending in…")
 * ------------------------------------------------------------------ */

/** Ids still to load per collection, for "more". */
const remaining = new Map<string, (number | string)[]>()
const FIRST_PAGE = 100

async function getCollection({ id }: { id: string }): Promise<CollectionPage> {
  const system = id.startsWith(`${SOURCE}:system:`)
  const raw = await api<Raw>(system ? `/system-playlists/${rawId(id)}` : `/playlists/${rawId(id)}`, system ? {} : { representation: 'full' })
  const all: Raw[] = raw.tracks ?? []
  const first = await fullTracks(all.slice(0, FIRST_PAGE))
  remaining.set(id, all.slice(FIRST_PAGE).map((track) => track.id))
  const collection = toCollection(raw)
  const user = raw.user
  return {
    id,
    kind: collection.type === 'album' ? 'album' : 'playlist',
    title: raw.title,
    subtitle: [user?.username ?? 'SoundCloud', raw.track_count ? `${raw.track_count} tracks` : ''].filter(Boolean).join(' • '),
    description: raw.description || undefined,
    thumbnail: collection.thumbnail,
    artists: user ? [{ id: `${SOURCE}:user:${user.id}`, name: user.username }] : [],
    year: collection.type === 'album' ? collection.year : undefined,
    songs: first.map(toSong),
    hasMore: all.length > FIRST_PAGE,
    sections: [],
  }
}

async function moreOfCollection({ id }: { id: string }) {
  const ids = remaining.get(id) ?? []
  const next = await fullTracks(ids.slice(0, FIRST_PAGE).map((trackIdValue) => ({ id: trackIdValue })))
  remaining.set(id, ids.slice(FIRST_PAGE))
  return { songs: next.map(toSong), hasMore: ids.length > FIRST_PAGE }
}

/* ------------------------------------------------------------------ *
 * Artists (SoundCloud users)
 * ------------------------------------------------------------------ */

async function getArtist({ id }: { id: string }): Promise<ArtistPage> {
  const user = rawId(id)
  const [profile, top, albums, playlists, latest] = await Promise.all([
    api<Raw>(`/users/${user}`),
    settled(api<{ collection: Raw[] }>(`/users/${user}/toptracks`, { limit: 10 })),
    settled(api<{ collection: Raw[] }>(`/users/${user}/albums`, { limit: 20 })),
    settled(api<{ collection: Raw[] }>(`/users/${user}/playlists_without_albums`, { limit: 20 })),
    settled(api<{ collection: Raw[] }>(`/users/${user}/tracks`, { limit: 20 })),
  ])
  return {
    id,
    name: profile.username,
    description: profile.description || undefined,
    subscribers: typeof profile.followers_count === 'number' ? `${compactNumber(profile.followers_count)} followers` : undefined,
    thumbnail: artworkAt(profile.avatar_url),
    shuffle: { playlistId: `artist-shuffle:${user}` },
    radio: { playlistId: `artist-radio:${user}` },
    sections: [
      ...section('top', 'Popular tracks', (top?.collection ?? []).map(toItem), 'list'),
      ...section('albums', 'Albums', (albums?.collection ?? []).map(toItem)),
      ...section('latest', 'Latest tracks', (latest?.collection ?? []).map(toItem), 'list'),
      ...section('playlists', 'Playlists', (playlists?.collection ?? []).map(toItem)),
    ],
  }
}

/* ------------------------------------------------------------------ *
 * Queues: radios are SoundCloud's related tracks
 * ------------------------------------------------------------------ */

async function related(track: string, next?: string): Promise<QueuePage> {
  const page = await api<{ collection: Raw[]; next_href?: string }>(next ?? `/tracks/${track}/related`, next ? {} : { limit: 50 })
  return { songs: page.collection.filter(isFull).map(toSong), continuation: page.next_href }
}

function shuffle<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const queue = {
  async start({ playlistId }: { playlistId?: string }): Promise<QueuePage> {
    const value = String(playlistId ?? '')
    if (value.startsWith('artist-shuffle:')) {
      const page = await api<{ collection: Raw[] }>(`/users/${value.slice('artist-shuffle:'.length)}/tracks`, { limit: 50 })
      return { songs: shuffle(page.collection.filter(isFull).map(toSong)) }
    }
    if (value.startsWith('artist-radio:')) {
      const top = await api<{ collection: Raw[] }>(`/users/${value.slice('artist-radio:'.length)}/toptracks`, { limit: 1 })
      const [first] = top.collection
      if (!first) return { songs: [] }
      const radio = await related(String(first.id))
      return { ...radio, songs: [toSong(first), ...radio.songs] }
    }
    return { songs: [] }
  },
  more: ({ continuation }: { continuation: string }) => related('', continuation),
  async radio(seed: RadioSeed): Promise<QueuePage> {
    if (seed.kind === 'song') {
      const radio = await related(rawId(seed.song.id))
      return { ...radio, songs: [seed.song, ...radio.songs.filter((song) => song.id !== seed.song.id)] }
    }
    const page = await getCollection({ id: seed.kind === 'album' ? seed.album.id : seed.playlist.id })
    const [first] = page.songs
    if (!first) return { songs: [] }
    const radio = await related(rawId(first.id))
    return { ...radio, songs: [first, ...radio.songs] }
  },
}

/* ------------------------------------------------------------------ *
 * Library (signed in)
 * ------------------------------------------------------------------ */

let likesNext: string | null = null

const library = {
  async liked() {
    if (!me.value) await refreshProfile()
    const page = await api<{ collection: Raw[]; next_href?: string }>(`/users/${me.value?.id}/track_likes`, { limit: 50 })
    likesNext = page.next_href ?? null
    return { songs: page.collection.map((entry) => entry.track).filter(isFull).map(toSong), hasMore: Boolean(likesNext) }
  },
  async likedMore() {
    if (!likesNext) return { songs: [], hasMore: false }
    const page = await api<{ collection: Raw[]; next_href?: string }>(likesNext)
    likesNext = page.next_href ?? null
    return { songs: page.collection.map((entry) => entry.track).filter(isFull).map(toSong), hasMore: Boolean(likesNext) }
  },
  async like({ song, liked }: { song: Song; liked: boolean }) {
    if (song.source !== SOURCE) return
    if (!me.value) await refreshProfile()
    await api(`/users/${me.value?.id}/track_likes/${rawId(song.id)}`, {}, { method: liked ? 'PUT' : 'DELETE' })
  },
  async playlists() {
    const page = await api<{ collection: Raw[] }>('/me/library/all', { limit: 50 })
    return page.collection
      .map((entry) => entry.playlist ?? entry.system_playlist)
      .filter(Boolean)
      .map(toCollection)
      .filter((item) => item.type === 'playlist')
  },
  async artists() {
    if (!me.value) await refreshProfile()
    const page = await api<{ collection: Raw[] }>(`/users/${me.value?.id}/followings`, { limit: 100 })
    return page.collection.map(toArtist)
  },
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

async function refreshProfile() {
  if (!token.value) return null
  const profile = await api<Raw>('/me')
  setMe({ id: profile.id, name: profile.username, photo: artworkAt(profile.avatar_url) })
  return me.value
}

/**
 * What was pasted: a cookie header ("oauth_token=…; oauth_refresh_token=…"), the two
 * values on separate lines, or just the access token (a JWT: header.payload.signature).
 */
function parseSession(input: string): Session | null {
  const text = input.trim().replace(/^OAuth\s+/i, '')
  const cookie = (name: string) => new RegExp(`(?:^|[;\\s])${name}=([^;\\s]+)`).exec(text)?.[1]
  const pieces = text.split(/[\s;]+/).map((piece) => piece.replace(/^[\w-]+=/, '')).filter(Boolean)
  const jwt = (value: string | undefined) => (value && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ? value : undefined)
  const access = jwt(cookie('oauth_token')) ?? pieces.find((piece) => jwt(piece)) ?? (/^[\w.-]{20,}$/.test(text) ? text : undefined)
  if (!access) return null
  const refresh = cookie('oauth_refresh_token') ?? pieces.find((piece) => piece !== access && /^[\w.-]{16,}$/.test(piece))
  return sessionFrom(access, refresh)
}

async function useSession(fresh: Session | null): Promise<boolean> {
  if (!fresh) {
    notify("That doesn't look like a SoundCloud token: oauth_token is a long value with two dots in it")
    return false
  }
  if (fresh.expiresAt && fresh.expiresAt < Date.now() && !fresh.refresh) {
    notify('That token has expired (they last an hour). Copy a fresh one, or paste oauth_refresh_token too')
    return false
  }
  setSession(fresh)
  try {
    if (fresh.expiresAt && fresh.expiresAt < Date.now()) await renewSession()
    await refreshProfile()
  } catch (error) {
    setSession(null)
    notify((error as Error).message)
    return false
  }
  notify(`Signed in to SoundCloud as ${me.value?.name ?? 'you'}${canRenew() ? '' : '. Without oauth_refresh_token the sign-in lasts an hour'}`)
  if (Noctis.activeService.value?.id !== SOURCE) {
    confirm({
      title: 'Use SoundCloud?',
      message: 'Show your SoundCloud home, search and library instead of the current service? You can switch back in Settings → Content.',
      confirmLabel: 'Use SoundCloud',
      onConfirm: () => {
        Noctis.activeServiceId.value = SOURCE
      },
    })
  }
  return true
}

async function signIn() {
  if (!auth.canCaptureWeb) {
    pasteToken()
    return
  }
  try {
    // SoundCloud's own page; the window closes once it sets oauth_token. Its
    // oauth_refresh_token (httpOnly) comes along, so the session renews itself.
    const { value, cookies } = await auth.openCookieLogin({ url: 'https://soundcloud.com/signin', cookieUrl: 'https://soundcloud.com', cookie: 'oauth_token', title: 'Sign in to SoundCloud' })
    await useSession(sessionFrom(value, /(?:^|;\s*)oauth_refresh_token=([^;]+)/.exec(cookies)?.[1]))
  } catch (error) {
    if (!/cancel/i.test((error as Error).message)) notify((error as Error).message)
  }
}

function pasteToken() {
  showTextDialog({
    title: 'Sign in with a token',
    description:
      'Sign in on soundcloud.com in a browser, open DevTools → Application → Cookies → https://soundcloud.com, and copy "oauth_token" (it starts with eyJ). Add "oauth_refresh_token" on a second line so the sign-in renews itself; without it, it lasts an hour. Treat both like a password.',
    placeholder: 'eyJ…\n(oauth_refresh_token)',
    multiline: true,
    confirmLabel: 'Sign in',
    async onConfirm(value) {
      await useSession(parseSession(value))
    },
  })
}

/** Settings → Accounts asks first. */
async function signOut() {
  await auth.clearSiteCookies('https://soundcloud.com')
  setSession(null)
  setMe(null)
}

/* ------------------------------------------------------------------ *
 * The service and its settings
 * ------------------------------------------------------------------ */

const service: ServiceDefinition = {
  name: 'SoundCloud',
  icon: 'cloud',
  home: { load: loadHome },
  search: {
    filters: [
      { id: 'song', label: 'Tracks' },
      { id: 'artist', label: 'Artists' },
      { id: 'album', label: 'Albums' },
      { id: 'playlist', label: 'Playlists' },
    ],
    query: searchQuery,
    more: searchMore,
    suggestions,
  },
  albums: { get: getCollection },
  playlists: { get: getCollection, more: moreOfCollection },
  artists: { get: getArtist },
  queue,
  get library() {
    return signedIn.value ? library : undefined
  },
  streams: { resolve: resolveStream },
  links: {
    share: (item) => permalinkOf(item.id),
  },
  thumbnails: {
    resize: (url, size) => (/\.sndcdn\.com\//.test(url) ? artworkAt(url, size) : undefined),
  },
  account: {
    get signedIn() {
      return signedIn.value
    },
    get info() {
      return me.value ? { name: me.value.name, handle: 'SoundCloud', photo: me.value.photo } : null
    },
    get sessionKey() {
      return me.value ? `user:${me.value.id}` : 'guest'
    },
    section: SOURCE,
    signInTitle: 'Sign in to SoundCloud',
    signInDescription: 'Your likes, playlists, follows and feed',
    refresh: refreshProfile,
    // Offered in Settings → Accounts.
    signInMethods: [
      {
        id: 'web',
        label: 'Sign in to SoundCloud',
        description: "On SoundCloud's own page: email, Google, Apple or Facebook",
        get hidden() {
          return !auth.canCaptureWeb
        },
        run: signIn,
      },
      { id: 'token', icon: 'cookie', label: 'Sign in with a token', description: 'oauth_token (and oauth_refresh_token) from soundcloud.com', run: pasteToken },
    ],
    signOut,
  },
}

const SECTION = {
  id: SOURCE,
  icon: 'cloud',
  title: 'SoundCloud',
  get description() {
    return signedIn.value ? `Signed in as ${me.value?.name ?? 'you'}` : 'Not signed in'
  },
}

function defineSettings(Plugin: PluginScope['Plugin']) {
  Plugin.defineSection(SECTION, [
    {
      id: 'note',
      type: 'note',
      text: 'Without signing in you can still browse, search and play SoundCloud. Go+ tracks play a 30-second preview unless your account has Go+. Noctis uses SoundCloud the way its web app does, which SoundCloud doesn\'t officially support; it may stop working until the plugin is updated.',
    },
  ])
}

export default function soundcloud({ Plugin }: PluginScope) {
  initSession(Plugin.storage as never)
  let stopMatching: (() => void) | null = null

  const attach = () => {
    Plugin.defineService(SOURCE, service)
    defineSettings(Plugin)
    // Songs from elsewhere (a server's MusicBrainz songs, other services) can play from here.
    // Uploads are often remixes and covers, so only close matches count.
    // Previews of Go+ tracks are 30 seconds long: no stand-in for the whole song.
    stopMatching ??= Noctis.libs.matching.offerAsSource(SOURCE, { minScore: 0.7, skip: ['spotify'], accept: (song) => !previews.has(song.id) })
    if (signedIn.value && !me.value) void settled(refreshProfile())
  }

  const detach = () => {
    stopMatching?.()
    stopMatching = null
    Plugin.removeService(SOURCE)
    Plugin.removeSection(SECTION.id)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}

