import type { ArtistPage, CollectionPage, HomeResult, Item, PluginScope, QueuePage, RadioSeed, SearchResult, Section, ServiceDefinition, Song } from './host'
import { Noctis } from './host'
import {
  api,
  apiPost,
  artistId,
  asShorts,
  compactNumber,
  coverUrl,
  fullTracks,
  initSession,
  me,
  numericTrackId,
  rawId,
  refreshProfile,
  resizeCover,
  requestDeviceCode,
  pollDeviceToken,
  setMe,
  setSession,
  SOURCE,
  toAlbum,
  toArtist,
  toItem,
  toPlaylist,
  toSong,
  token,
  YandexError,
  DEFAULT_DEVICE_NAME,
  deviceName,
  setDeviceName,
  type DeviceCode,
  type Raw,
} from './api'
import { showCodeDialog } from './code-dialog'
import { initStreamPrefs, preferLossless, checkReport, qualityCheck, resolveStream, streamReport } from './stream'

/**
 * Yandex Music for Noctis: a service (home, search, artists, albums, playlists,
 * radios, your library) and a source for songs from elsewhere (Noctis.libs.matching).
 *
 * - Signed out, browsing and search work, but the API only offers 30-second preview
 *   streams. Signed in (OAuth device flow or pasted token), full playback and your
 *   library open up; Plus accounts can also play lossless (FLAC).
 * - The mobile API (api.music.yandex.net) serves permissive CORS, so the same code
 *   runs in the browser and on a device through Noctis.libs.http.
 *
 * Unofficial: this talks to the API the official apps talk to. It may break until the
 * plugin is updated. The API also geo-restricts content outside Yandex's supported
 * region — some answers come back "Unavailable For Legal Reasons" from outside it.
 */

const { computed } = Noctis.packages.vue
const { notify } = Noctis.libs.snackbar
const { confirm, showTextDialog } = Noctis.libs.ui

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
 * Home: the landing blocks, plus your feed when signed in
 * ------------------------------------------------------------------ */

const LANDING_BLOCKS = 'personalplaylists,new-releases,new-playlists,mixes,chart,artists,albums,playlists'

function entitiesOf(block: Raw): Item[] {
  return (block.entities ?? [])
    .map((entity: Raw): Item | null => {
      const data = entity?.data
      if (!data) return null
      const type = String(entity.type ?? '').replace(/-/g, '')
      if (type === 'personalplaylist') return data.playlist ? toPlaylist(data.playlist) : null
      if (type === 'chartitem') return data.track ? toSong(data.track) : null
      if (type === 'album') return toAlbum(data.album ?? data)
      if (type === 'playlist') return toPlaylist(data.playlist ?? data)
      if (type === 'artist') return toArtist(data.artist ?? data)
      return null
    })
    .filter((item: Item | null): item is Item => item !== null)
}

async function loadHome(): Promise<HomeResult> {
  const [landing, feed] = await Promise.all([
    api<{ blocks: Raw[] }>(`/landing3`, { blocks: LANDING_BLOCKS }),
    signedIn.value ? settled(api<{ generatedPlaylists: Raw[] }>(`/feed`)) : null,
  ])
  const sections: Section[] = []
  if (feed?.generatedPlaylists?.length) {
    sections.push(...section('made-for-you', 'Made for you', feed.generatedPlaylists.map((gp) => (gp?.data ? toPlaylist(gp.data) : null))))
  }
  for (const block of landing.blocks ?? []) {
    const title = block.title ?? ''
    const items = entitiesOf(block)
    // The chart is a ranked list of songs; the rest are shelves of covers.
    sections.push(...section(String(block.id ?? title), title, items, block.type === 'chart' ? 'list' : 'carousel', block.description || undefined))
  }
  return { sections, filters: [], selectedFilter: null, hasMore: false }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const SEARCH_TYPES: Record<string, string> = {
  song: 'track',
  artist: 'artist',
  album: 'album',
  playlist: 'playlist',
}

const PER_PAGE = 20
let lastSearch: { query: string; type: string; page: number; hasMore: boolean } | null = null

function groupItems(group: Raw | null | undefined): Item[] {
  return ((group?.results ?? []) as Raw[]).map(toItem).filter((item): item is Item => item !== null)
}

async function searchQuery({ query, type }: { query: string; type: string }): Promise<SearchResult> {
  if (type !== 'all') {
    const yandexType = SEARCH_TYPES[type] ?? type
    const page = await api<Raw>(`/search`, { text: query, type: yandexType, page: 0, nocorrect: 'false', 'playlist-in-best': 'true' })
    const group = page[yandexType] ?? null
    const items = groupItems(group)
    const total = Number(group?.total ?? items.length)
    lastSearch = { query, type, page: 0, hasMore: items.length > 0 && items.length < total }
    return { sections: [], items, hasMore: lastSearch.hasMore, correctedQuery: page.correctedQuery || undefined }
  }
  const page = await api<Raw>(`/search`, { text: query, type: 'all', page: 0, nocorrect: 'false', 'playlist-in-best': 'true' })
  lastSearch = null
  const best = page.best?.result ? toItem(page.best.result) : null
  const tracks = groupItems(page.tracks)
  return {
    sections: [
      ...section('top', 'Top result', best ? [best] : [], 'list'),
      ...section('songs', 'Songs', tracks.slice(0, 12), 'list'),
      ...section('artists', 'Artists', groupItems(page.artists)),
      ...section('albums', 'Albums', groupItems(page.albums)),
      ...section('playlists', 'Playlists', groupItems(page.playlists)),
    ],
    items: [],
    hasMore: false,
    correctedQuery: page.correctedQuery || undefined,
  }
}

async function searchMore(): Promise<{ items: Item[]; hasMore: boolean }> {
  if (!lastSearch?.hasMore) return { items: [], hasMore: false }
  const next = lastSearch.page + 1
  const yandexType = SEARCH_TYPES[lastSearch.type] ?? lastSearch.type
  const page = await api<Raw>(`/search`, { text: lastSearch.query, type: yandexType, page: next, nocorrect: 'false', 'playlist-in-best': 'true' })
  const group = page[yandexType] ?? null
  const items = groupItems(group)
  const total = Number(group?.total ?? 0)
  const hasMore = items.length > 0 && (next + 1) * PER_PAGE < total
  lastSearch = { ...lastSearch, page: next, hasMore }
  return { items, hasMore }
}

async function suggestions({ input }: { input: string }) {
  const page = await api<{ suggestions?: Raw[] }>(`/search/suggest`, { part: input })
  return { queries: (page.suggestions ?? []).map((entry: Raw) => entry?.text).filter(Boolean), items: [] }
}

/* ------------------------------------------------------------------ *
 * Albums and playlists
 * ------------------------------------------------------------------ */

async function getAlbumPage({ id }: { id: string }): Promise<CollectionPage> {
  const album = await api<Raw>(`/albums/${rawId(id)}/with-tracks`)
  const tracks = (album.volumes ?? []).flatMap((volume: Raw[]) => volume ?? [])
  const artists = (album.artists ?? []).filter((a: Raw) => a?.name).map((a: Raw): { id?: string; name: string } => ({ id: a.id ? artistId(a.id) : undefined, name: a.name as string }))
  return {
    id,
    kind: 'album',
    title: album.title ?? 'Album',
    subtitle: artists.map((a: { name: string }) => a.name).join(', '),
    description: album.description || undefined,
    thumbnail: coverUrl(album.cover?.uri ?? album.ogImage),
    artists,
    year: album.year !== undefined && album.year !== null ? String(album.year) : undefined,
    songs: tracks.map(toSong),
    hasMore: false,
    sections: [],
  }
}

async function getPlaylistPage({ id }: { id: string }): Promise<CollectionPage> {
  const [uid, kind] = rawId(id).split(':')
  const playlist = await api<Raw>(`/users/${uid}/playlists/${kind}`)
  const entries = playlist.tracks ?? []
  // Newer API embeds full track objects; older returns only { id, albumId } shorts.
  const embedded = entries.filter((entry: Raw) => entry?.track).map((entry: Raw) => entry.track)
  const tracks = embedded.length === entries.length && entries.length > 0
    ? embedded
    : await fullTracks(asShorts(entries))
  const owner = playlist.owner ?? {}
  return {
    id,
    kind: 'playlist',
    title: playlist.title ?? 'Playlist',
    subtitle: [owner.login ?? owner.name, playlist.trackCount ? `${playlist.trackCount} songs` : ''].filter(Boolean).join(' · '),
    description: playlist.description || undefined,
    thumbnail: coverUrl(playlist.cover?.uri ?? playlist.ogImage),
    artists: [],
    songs: tracks.map(toSong),
    hasMore: false,
    sections: [],
  }
}

/* ------------------------------------------------------------------ *
 * Artists
 * ------------------------------------------------------------------ */

async function getArtistPage({ id }: { id: string }): Promise<ArtistPage> {
  const artistRawId = rawId(id)
  const brief = await api<Raw>(`/artists/${artistRawId}/brief-info`)
  const artist = brief.artist ?? {}
  const listeners = Number(brief.stats?.lastMonthListeners ?? 0)
  return {
    id,
    name: artist.name ?? 'Artist',
    description: artist.description?.text || brief.artist?.hand_made_description || undefined,
    subscribers: listeners > 0 ? `${compactNumber(listeners)} listeners a month` : undefined,
    thumbnail: coverUrl(artist.cover?.uri ?? artist.ogImage ?? artist.opImage),
    shuffle: { playlistId: `artist-shuffle:${artistRawId}` },
    radio: { playlistId: `artist-radio:${artistRawId}` },
    sections: [
      ...section('popular', 'Popular', (brief.popular_tracks ?? []).map(toSong), 'list'),
      ...section('albums', 'Albums', (brief.albums ?? []).map(toAlbum)),
      ...section('latest', 'Latest releases', (brief.last_releases ?? []).map(toAlbum)),
      ...section('also-albums', 'Compilations', (brief.also_albums ?? []).map(toAlbum)),
      ...section('similar', 'Fans also like', (brief.similar_artists ?? []).map(toArtist)),
    ],
  }
}

/* ------------------------------------------------------------------ *
 * Queues: radios come from Yandex's rotor engine
 * ------------------------------------------------------------------ */

interface RadioState {
  station: string
  batchId: string
  lastTrackId: string
}

function stationFor(seed: RadioSeed): string | null {
  if (seed.kind === 'song') return `track:${numericTrackId(seed.song.id)}`
  if (seed.kind === 'album') return `album:${rawId(seed.album.id)}`
  const [uid, kind] = rawId(seed.playlist.id).split(':')
  return uid && kind ? `playlist:${uid}_${kind}` : null
}

async function rotorTracks(station: string, queue?: string): Promise<QueuePage & { state?: RadioState }> {
  const params: Record<string, string | number> = { settings2: 'true' }
  if (queue) params.queue = queue
  const page = await api<Raw>(`/rotor/station/${station}/tracks`, params)
  const songs = (page.sequence ?? [])
    .map((entry: Raw) => (entry?.track ? toSong(entry.track) : null))
    .filter((song: Song | null): song is Song => song !== null)
  const last = (page.sequence ?? []).filter((entry: Raw) => entry?.track).pop()
  const state: RadioState | undefined = page.batchId
    ? { station, batchId: String(page.batchId), lastTrackId: last ? String(last.track.id) : '' }
    : undefined
  return { songs, continuation: state ? JSON.stringify(state) : undefined }
}

async function rotorMore(state: RadioState): Promise<QueuePage> {
  // The station expects to know the last track started before it serves the next page.
  await api(`/rotor/station/${state.station}/feedback`, { 'batch-id': state.batchId }, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'trackStarted', event: 'trackStarted', trackId: state.lastTrackId, timestamp: new Date().toISOString() }),
  }).catch(() => {})
  const page = await rotorTracks(state.station, state.lastTrackId)
  return { songs: page.songs, continuation: page.continuation }
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
      const page = await api<Raw>(`/artists/${value.slice('artist-shuffle:'.length)}/tracks`, { page: 0, 'page-size': 50 })
      return { songs: shuffle((page.tracks ?? []).map(toSong)) }
    }
    if (value.startsWith('artist-radio:')) {
      const page = await rotorTracks(`artist:${value.slice('artist-radio:'.length)}`)
      return { songs: page.songs, continuation: page.continuation }
    }
    return { songs: [] }
  },
  async more({ continuation }: { continuation: string }): Promise<QueuePage> {
    try {
      const state = JSON.parse(continuation) as RadioState
      if (!state.station) return { songs: [] }
      return await rotorMore(state)
    } catch {
      return { songs: [] }
    }
  },
  async radio(seed: RadioSeed): Promise<QueuePage> {
    const station = stationFor(seed)
    if (!station) return { songs: [] }
    const page = await rotorTracks(station)
    if (seed.kind === 'song') {
      return { ...page, songs: [seed.song, ...page.songs.filter((song) => song.id !== seed.song.id)] }
    }
    return page
  },
}

/* ------------------------------------------------------------------ *
 * Library (signed in)
 * ------------------------------------------------------------------ */

const library = {
  async liked() {
    if (!me.value) await refreshProfile()
    const uid = me.value?.uid
    if (!uid) return { songs: [], hasMore: false }
    const page = await api<Raw>(`/users/${uid}/likes/tracks`)
    const lib = page?.library ?? page ?? {}
    const tracks = await fullTracks(asShorts(lib.tracks ?? lib.ids ?? []))
    return { songs: tracks.map(toSong), hasMore: false }
  },
  async likedMore() {
    return { songs: [], hasMore: false }
  },
  async like({ song, liked }: { song: Song; liked: boolean }) {
    if (song.source !== SOURCE) return
    const uid = me.value?.uid
    if (!uid) throw new YandexError('Sign in to Yandex Music to like songs', 401)
    const action = liked ? 'add-multiple' : 'remove'
    await apiPost(`/users/${uid}/likes/tracks/${action}`, { 'track-ids': rawId(song.id) })
  },
  async playlists() {
    if (!me.value) await refreshProfile()
    const uid = me.value?.uid
    if (!uid) return []
    const list = await api<Raw[]>(`/users/${uid}/playlists/list`)
    return (list ?? [])
      .filter((playlist: Raw) => playlist?.kind !== 3) // kind 3 is the "liked tracks" pseudo-playlist
      .map(toPlaylist)
  },
  async artists() {
    if (!me.value) await refreshProfile()
    const uid = me.value?.uid
    if (!uid) return []
    const likes = await api<Raw[]>(`/users/${uid}/likes/artists`)
    const artists = (likes ?? []).map((entry: Raw) => entry?.artist ?? entry).filter((artist: Raw) => artist?.id !== undefined && artist.name)
    return artists.map(toArtist)
  },
}

/* ------------------------------------------------------------------ *
 * Signing in: OAuth device flow, or a pasted token
 * ------------------------------------------------------------------ */

async function afterSignIn() {
  await refreshProfile()
  notify(`Signed in to Yandex Music as ${me.value?.name ?? 'you'}`)
  if (Noctis.activeService.value?.id !== SOURCE) {
    confirm({
      title: 'Use Yandex Music?',
      message: "Show Yandex Music's home, search and library instead of the current service? You can switch back in Settings → Content.",
      confirmLabel: 'Use Yandex Music',
      onConfirm: () => {
        Noctis.activeServiceId.value = SOURCE
      },
    })
  }
}

async function deviceSignIn() {
  let code: DeviceCode
  try {
    code = await requestDeviceCode()
  } catch (error) {
    notify((error as Error).message)
    return
  }
  let cancelled = false
  const dialog = showCodeDialog({
    title: 'Confirm on Yandex',
    description: `Open the link and enter this code. After you approve, the account signs in here by itself and this closes.`,
    code: code.userCode,
    link: code.verificationUrl,
    status: 'Waiting for you to approve…',
    onCancel: () => {
      cancelled = true
    },
  })
  const interval = Math.max(2, code.interval) * 1000
  const deadline = Date.now() + code.expiresIn * 1000
  while (!cancelled && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, interval))
    if (cancelled) return
    const result = await pollDeviceToken(code.deviceCode).catch(() => ({ status: 'pending' as const }))
    if (result.status === 'pending') continue
    dialog.close()
    if (result.status === 'failed') {
      notify(`Yandex refused the sign-in: ${result.error}`)
      return
    }
    setSession(result.token)
    try {
      await afterSignIn()
    } catch (error) {
      notify((error as Error).message)
    }
    return
  }
  if (!cancelled) {
    dialog.close()
    notify('The sign-in code expired. Get another in Settings → Accounts.')
  }
}

function pasteToken() {
  showTextDialog({
    title: 'Sign in with a token',
    description:
      "Paste your Yandex account's OAuth token (the one unofficial Yandex Music apps use). Treat it like a password.",
    placeholder: 'y0_AgAAA…',
    multiline: true,
    confirmLabel: 'Sign in',
    async onConfirm(value) {
      const clean = value.trim().replace(/^OAuth\s+/i, '')
      if (!clean) {
        notify('No token entered')
        return
      }
      setSession(clean)
      try {
        await afterSignIn()
      } catch (error) {
        setSession(null)
        notify((error as Error).message)
      }
    },
  })
}

async function signOut() {
  setSession(null)
  setMe(null)
}

/* ------------------------------------------------------------------ *
 * The service and its settings
 * ------------------------------------------------------------------ */

const service: ServiceDefinition = {
  name: 'Yandex Music',
  icon: 'music',
  home: { load: loadHome },
  search: {
    filters: [
      { id: 'song', label: 'Songs' },
      { id: 'artist', label: 'Artists' },
      { id: 'album', label: 'Albums' },
      { id: 'playlist', label: 'Playlists' },
    ],
    query: searchQuery,
    more: searchMore,
    suggestions,
  },
  albums: { get: getAlbumPage },
  playlists: { get: getPlaylistPage },
  artists: { get: getArtistPage },
  queue,
  get library() {
    return signedIn.value ? library : undefined
  },
  streams: { resolve: resolveStream },
  links: {
    share: (item) => {
      const raw = rawId(item.id)
      if (item.type === 'song') {
        const [trackId, albumIdValue] = raw.split(':')
        return albumIdValue ? `https://music.yandex.ru/album/${albumIdValue}/track/${trackId}` : `https://music.yandex.ru/track/${trackId}`
      }
      if (item.type === 'album') return `https://music.yandex.ru/album/${raw}`
      if (item.type === 'artist') return `https://music.yandex.ru/artist/${raw}`
      if (item.type === 'playlist') {
        const [uid, kind] = raw.replace(/^playlist:/, '').split(':')
        return uid && kind ? `https://music.yandex.ru/users/${uid}/playlists/${kind}` : undefined
      }
      return undefined
    },
  },
  thumbnails: {
    resize: (url, size) => (url.includes('yandex.net/') || url.includes('yandex.ru/') ? resizeCover(url, size) : undefined),
  },
  account: {
    get signedIn() {
      return signedIn.value
    },
    get info() {
      return me.value ? { name: me.value.name, handle: me.value.login, photo: undefined } : null
    },
    get sessionKey() {
      return me.value ? `user:${me.value.uid}` : 'guest'
    },
    section: SOURCE,
    signInTitle: 'Sign in to Yandex Music',
    signInDescription: 'Your likes, playlists and personalised home',
    refresh: refreshProfile,
    signInMethods: [
      {
        id: 'device',
        icon: 'dialpad',
        label: 'Sign in with a code',
        description: 'Approve a short code on yandex.ru, no password needed',
        run: deviceSignIn,
      },
      { id: 'token', icon: 'cookie', label: 'Sign in with a token', description: 'Paste the OAuth token of your Yandex account', run: pasteToken },
    ],
    signOut,
  },
}

const SECTION = {
  id: SOURCE,
  icon: 'music',
  title: 'Yandex Music',
  get description() {
    return signedIn.value ? `Signed in as ${me.value?.name ?? 'you'}` : 'Not signed in'
  },
}

function defineSettings(Plugin: PluginScope['Plugin']) {
  Plugin.defineSection(SECTION, [
    Noctis.group('account', [
      {
        id: 'account',
        icon: 'account',
        title: 'Account',
        get value() {
          return signedIn.value ? `Signed in as ${me.value?.name ?? 'you'}` : 'Not signed in · sign in'
        },
        chevron: true,
        onClick: () => void Noctis.libs.navigation.navigate({ name: 'settings-page', page: 'accounts' }),
      },
    ]),
    Noctis.group('device', [
      {
        id: 'device-name',
        icon: 'devices',
        title: 'Device name',
        description: 'What Yandex shows for this sign-in; applies the next time you sign in',
        get value() {
          return deviceName.value
        },
        onClick: () =>
          showTextDialog({
            title: 'Device name',
            description: `Shown in your Yandex account's list of devices. The default is "${DEFAULT_DEVICE_NAME}".`,
            placeholder: DEFAULT_DEVICE_NAME,
            confirmLabel: 'Save',
            onConfirm: (value) => setDeviceName(value),
          }),
      },
    ]),
    Noctis.group('playback', [
      {
        id: 'plan',
        icon: 'account',
        title: 'Yandex Plus',
        get value() {
          if (!signedIn.value) return 'Sign in to check'
          return me.value?.plus === undefined ? 'Checking…' : me.value.plus ? 'Active: FLAC and 320 kbps available' : 'Not active on this account: MP3 192 kbps only'
        },
        onClick: () => void settled(refreshProfile()),
      },
      {
        id: 'quality-check',
        icon: 'sync',
        title: 'Run quality check',
        get description() {
          return checkReport.value || 'Asks Yandex what it grants this account, shows the answer here and tries to copy it'
        },
        onClick: async () => {
          notify('Checking…')
          const report = await qualityCheck()
          checkReport.value = report.replace(/\n/g, '  •  ')
          try {
            await navigator.clipboard.writeText(report)
            notify('Quality report copied')
          } catch {
            notify('Could not copy the report')
          }
        },
      },
      {
        id: 'last-stream',
        icon: 'info',
        title: 'Last stream',
        description: 'What the most recent song played as, and why not better if it failed',
        get value() {
          return streamReport.value
        },
      },
      {
        id: 'lossless',
        icon: 'graphic_eq',
        title: 'Prefer lossless (FLAC)',
        description: 'Plays FLAC when Yandex offers it for the track (needs Plus), otherwise 320 kbps MP3. Takes effect for songs you play next',
        toggle: {
          get value() {
            return preferLossless.value
          },
          set(value: boolean) {
            preferLossless.value = value
            Plugin.storage.set('prefer-lossless', value)
          },
        },
      },
    ]),
    {
      id: 'note',
      type: 'note',
      text: 'Without signing in, Yandex Music only gives 30-second previews. Signed in, you hear whatever your plan covers (FLAC needs Plus). Noctis uses the API the official apps use, which Yandex doesn\'t officially support, and Yandex restricts content outside its region; it may stop working until the plugin is updated.',
    },
  ])
}

export default function yandexMusic({ Plugin }: PluginScope) {
  initSession(Plugin.storage)
  initStreamPrefs(Plugin.storage)
  let stopMatching: (() => void) | null = null

  const attach = () => {
    Plugin.defineService(SOURCE, service)
    defineSettings(Plugin)
    // Songs from elsewhere (a server's MusicBrainz songs, other services) can play from here.
    // Without a sign-in only 30-second previews play, so they don't stand in for whole songs.
    stopMatching ??= Noctis.libs.matching.offerAsSource(SOURCE, { minScore: 0.7, skip: ['spotify'], accept: () => signedIn.value })
    // Always refresh: the plan (Plus or not) decides which qualities play.
    if (signedIn.value) void settled(refreshProfile())
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
