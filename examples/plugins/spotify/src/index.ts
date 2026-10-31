import type { ArtistPage, CollectionPage, HomeResult, Item, PluginScope, QueuePage, RadioSeed, Section, SearchResult, ServiceDefinition, Song } from './host'
import { Noctis } from './host'
import {
  accessToken,
  captureSession,
  deviceId,
  ensureOperations,
  gql,
  initSession,
  largest,
  me,
  operations,
  refreshProfile,
  setMe,
  setSession,
  signInWithCookies,
  signInWithToken,
  signedIn,
  SOURCE,
  type Raw,
} from './api'
import {
  compact,
  formatCount,
  imageOf,
  KIND,
  plainText,
  toItems,
  toItem,
  toSong,
  unwrap,
  artistRefs,
  yearOf,
} from './mapping'
import { emeAvailable, initStreamPrefs, preferClear, resolveStream, setPreferClear, streamReport } from './stream'

/**
 * Spotify for Noctis: home, search, albums, artists, playlists, radios, your library —
 * and audio from Spotify itself, through the web player's own flows:
 *
 * - The session: an open.spotify.com page (Noctis.libs.auth.captureWebResponse: hidden
 *   on Android, a window on desktop) runs Spotify's own code to get an access token.
 *   Signing in is a normal Spotify login page, followed in the same window by the
 *   player. Without signing in you still get an anonymous session: home, search,
 *   albums, artists and playlists.
 * - The data: the web player's GraphQL API (api-partner.spotify.com/pathfinder). Its
 *   operations are identified by hashes, read from the web player's own scripts, so a
 *   Spotify update doesn't need a plugin update.
 * - The audio: the same renditions the web player plays — a clear MP3 everywhere, and
 *   the DRM-protected MP4/FLAC (Widevine) wherever the device can decrypt. Downloads
 *   and the cache only take the clear MP3; protected files can't leave the decryption
 *   module.
 *
 * This is unofficial: Spotify can change any of it. Everything works in the Android
 * and desktop apps (the plain browser can at least paste cookies); DRM plays in
 * environments with a content decryption module.
 */

const { notify } = Noctis.libs.snackbar
const { ui } = Noctis.libs
const auth = Noctis.libs.auth

const section = (id: string, title: string, items: Item[], layout: Section['layout'] = 'carousel', extra: Partial<Section> = {}): Section | null =>
  items.length > 0 ? { id, title, layout, items, ...extra } : null

function shuffle<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */

/** Chip label → facet id, from the last home response. */
let homeFacets: Record<string, string> = {}

async function loadHome({ filter }: { filter?: string | null }): Promise<HomeResult> {
  const data = await gql('home', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sp_t: deviceId.value,
    facet: (filter && homeFacets[filter]) ?? '',
    sectionItemsLimit: 15,
    includeHomeChapterVideoCards: false,
    homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER',
    includeEpisodeContentRatingsV2: false,
  })
  const home = data?.home
  homeFacets = {}
  for (const chip of home?.homeChips ?? []) {
    const label = chip.label?.transformedLabel ?? chip.label?.text
    if (label && chip.id) homeFacets[label] = chip.id
  }

  const sections: Section[] = compact<Section>(
    (home?.sectionContainer?.sections?.items ?? []).map((entry: Raw, index: number): Section | null => {
      const items = toItems(entry.sectionItems?.items)
      const title = entry.data?.title?.transformedLabel ?? entry.data?.title?.text ?? ''
      if (!title || items.length === 0) return null
      const songsOnly = items.every((item) => item.type === 'song')
      return section(`home-${index}`, title, items, songsOnly && items.length >= 4 ? 'quick-picks' : 'carousel', {
        strapline: entry.data?.subtitle?.transformedLabel || undefined,
      })
    }),
  )
  if (sections.length === 0) throw new Error("Spotify's home came back empty")
  const filters = Object.keys(homeFacets)
  return { sections, filters, selectedFilter: filter && homeFacets[filter] ? filter : null, hasMore: false }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const SEARCH_FLAGS = {
  includeAudiobooks: false,
  includeArtistHasConcertsField: false,
  includePreReleases: false,
  includeAlbumPreReleases: false,
  includeAuthors: false,
  includeEpisodeContentRatingsV2: false,
}

/** Filter → operation and the page of `searchV2` it fills. */
const SEARCH_BY_TYPE: Record<string, [string, string]> = {
  song: ['searchTracks', 'tracksV2'],
  album: ['searchAlbums', 'albumsV2'],
  artist: ['searchArtists', 'artists'],
  playlist: ['searchPlaylists', 'playlists'],
}
const PAGE = 20
let searchOffset = 0

async function searchQuery({ query, type }: { query: string; type: string }): Promise<SearchResult> {
  searchOffset = 0
  const filtered = SEARCH_BY_TYPE[type]
  if (filtered) {
    const [operation, key] = filtered
    const data = await gql(operation, { ...SEARCH_FLAGS, searchTerm: query, offset: 0, limit: PAGE, numberOfTopResults: PAGE })
    const page = data?.searchV2?.[key]
    searchOffset = PAGE
    return { sections: [], items: toItems(page?.items), hasMore: (page?.totalCount ?? 0) > PAGE }
  }

  const data = await gql('searchDesktop', {
    ...SEARCH_FLAGS,
    searchTerm: query,
    offset: 0,
    limit: 10,
    numberOfTopResults: 5,
    isPrefix: null,
    sectionFilters: ['GENERIC'],
  })
  const results = data?.searchV2 ?? {}
  const top = toItems(results.topResultsV2?.itemsV2).slice(0, 1)
  const topId = top[0]?.id
  const without = (items: Item[]) => items.filter((item) => item.id !== topId)
  return {
    sections: compact([
      section('top', 'Top result', top, 'list'),
      section('songs', 'Songs', without(toItems(results.tracksV2?.items)), 'list'),
      section('artists', 'Artists', without(toItems(results.artists?.items)).slice(0, 5), 'list'),
      section('albums', 'Albums', without(toItems(results.albumsV2?.items)).slice(0, 6), 'list'),
      section('playlists', 'Playlists', without(toItems(results.playlists?.items)).slice(0, 6), 'list'),
    ]),
    items: [],
    hasMore: false,
  }
}

async function searchMore({ query, type }: { query: string; type: string }): Promise<{ items: Item[]; hasMore: boolean }> {
  const filtered = SEARCH_BY_TYPE[type]
  if (!filtered) return { items: [], hasMore: false }
  const [operation, key] = filtered
  const data = await gql(operation, { ...SEARCH_FLAGS, searchTerm: query, offset: searchOffset, limit: PAGE, numberOfTopResults: PAGE })
  const page = data?.searchV2?.[key]
  searchOffset += PAGE
  return { items: toItems(page?.items), hasMore: searchOffset < (page?.totalCount ?? 0) }
}

async function suggestions({ input }: { input: string }) {
  if (input.trim().length < 2) return { queries: [] as string[], items: [] as Item[] }
  const data = await gql('searchSuggestions', {
    query: input,
    limit: 10,
    numberOfTopResults: 10,
    offset: 0,
    includeAuthors: false,
    includeAlbumPreReleases: false,
    includeEpisodeContentRatingsV2: false,
  })
  const queries: string[] = []
  const items: Item[] = []
  for (const entry of data?.searchV2?.topResultsV2?.itemsV2 ?? []) {
    const entity = entry?.item?.data ?? entry?.data
    // Text suggestions are spotify:search:… entities with a `text`.
    if (entity?.text && String(entity.uri).split(':')[1] === 'search') queries.push(entity.text)
    else {
      const item = toItem(entry)
      if (item) items.push(item)
    }
  }
  return { queries: queries.slice(0, 6), items: items.slice(0, 4) }
}

/* ------------------------------------------------------------------ *
 * Albums, playlists, artists
 * ------------------------------------------------------------------ */

async function getAlbum({ id }: { id: string }): Promise<CollectionPage> {
  const first = (await gql('getAlbum', { uri: id, locale: '', offset: 0, limit: 50 }))?.albumUnion
  if (!first || first.__typename !== 'Album') throw new Error('This album is not available')
  const entries = [...(first.tracksV2?.items ?? [])]
  const total = first.tracksV2?.totalCount ?? entries.length
  while (entries.length < total && entries.length < 500) {
    const page = (await gql('getAlbum', { uri: id, locale: '', offset: entries.length, limit: 50 }))?.albumUnion?.tracksV2?.items ?? []
    if (page.length === 0) break
    entries.push(...page)
  }
  const songs = compact(entries.map((entry: Raw) => toSong(unwrap(entry), first)))
  const year = yearOf(first.date)
  const kind = KIND[first.type] ?? 'Album'
  const artists = artistRefs(first.artists)
  const more = toItems(first.moreAlbumsByArtist?.items?.[0]?.discography?.popularReleasesAlbums?.items).filter((item) => item.id !== id)

  return {
    id,
    kind: 'album',
    title: first.name,
    subtitle: [kind, year].filter(Boolean).join(' • '),
    secondSubtitle: `${songs.length} songs`,
    description: first.label ? `℗ ${first.label}` : undefined,
    thumbnail: imageOf(first),
    artists,
    year,
    songs,
    hasMore: false,
    sections: compact([artists[0] ? section('more', `More by ${artists[0].name}`, more) : null]),
  }
}

/** Playlist id → offset of its next page. */
const playlistOffsets = new Map<string, number>()
const PLAYLIST_PAGE = 100
const playlistSongs = (items: Raw[] | undefined) => compact((items ?? []).map((entry: Raw) => toSong(unwrap(entry?.itemV2 ?? entry))))

async function getPlaylist({ id }: { id: string }): Promise<CollectionPage> {
  const playlist = (
    await gql('fetchPlaylist', { uri: id, offset: 0, limit: PLAYLIST_PAGE, enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: false })
  )?.playlistV2
  if (!playlist || playlist.__typename !== 'Playlist') throw new Error(playlist?.message ?? 'This playlist is not available')
  const total = playlist.content?.totalCount ?? 0
  playlistOffsets.set(id, PLAYLIST_PAGE)
  const owner = playlist.ownerV2?.data?.name
  return {
    id,
    kind: 'playlist',
    title: playlist.name,
    subtitle: compact(['Playlist', owner]).join(' • '),
    secondSubtitle: total ? `${total} songs` : undefined,
    description: plainText(playlist.description),
    thumbnail: imageOf(playlist),
    artists: owner ? [{ name: owner }] : [],
    songs: playlistSongs(playlist.content?.items),
    hasMore: total > PLAYLIST_PAGE,
    sections: [],
  }
}

async function morePlaylist({ id }: { id: string }): Promise<{ songs: Song[]; hasMore: boolean }> {
  const offset = playlistOffsets.get(id) ?? PLAYLIST_PAGE
  const content = (await gql('fetchPlaylistContents', { uri: id, offset, limit: PLAYLIST_PAGE, includeEpisodeContentRatingsV2: false }))?.playlistV2
    ?.content
  playlistOffsets.set(id, offset + PLAYLIST_PAGE)
  return { songs: playlistSongs(content?.items), hasMore: offset + PLAYLIST_PAGE < (content?.totalCount ?? 0) }
}

async function artistOverview(id: string): Promise<Raw> {
  const artist = (await gql('queryArtistOverview', { uri: id, locale: '', preReleaseV2: false }))?.artistUnion
  if (!artist || artist.__typename !== 'Artist') throw new Error('This artist is not available')
  return artist
}

const topSongsOf = (artist: Raw): Song[] => compact((artist.discography?.topTracks?.items ?? []).map((entry: Raw) => toSong(unwrap(entry))))
const releases = (group: Raw | undefined) => toItems((group?.items ?? []).map((entry: Raw) => entry?.releases?.items?.[0] ?? entry))

async function getArtist({ id }: { id: string }): Promise<ArtistPage> {
  const artist = await artistOverview(id)
  const top = topSongsOf(artist)
  const listeners = formatCount(artist.stats?.monthlyListeners)
  const bio = plainText(artist.profile?.biography?.text)
  const name = String(artist.profile?.name ?? '')
  return {
    id,
    name,
    description: bio && bio.length > 400 ? `${bio.slice(0, 400)}…` : bio,
    subscribers: listeners ? `${listeners} monthly listeners` : undefined,
    thumbnail: imageOf(artist) ?? largest(artist.headerImage?.data?.sources),
    shuffle: top.length > 0 ? { playlistId: `artist-shuffle:${id}` } : undefined,
    radio: top.length > 0 ? { playlistId: `artist-radio:${id}` } : undefined,
    sections: compact([
      section('top', 'Popular', top, 'list'),
      section('popular', 'Popular releases', toItems(artist.discography?.popularReleasesAlbums?.items)),
      section('albums', 'Albums', releases(artist.discography?.albums)),
      section('singles', 'Singles and EPs', releases(artist.discography?.singles)),
      section('playlists', `Featuring ${name}`.trim(), toItems(artist.relatedContent?.featuringV2?.items)),
      section('related', 'Fans also like', toItems(artist.relatedContent?.relatedArtists?.items)),
    ]),
  }
}

/* ------------------------------------------------------------------ *
 * Queues: shuffles and radios from Spotify's own catalogue
 * ------------------------------------------------------------------ */

/** A radio for one song: the artist's popular tracks, shuffled, the song first. */
async function radioFromSong(track: Song): Promise<QueuePage> {
  const artist = track.artists.find((ref) => ref.id)?.id ?? track.artists[0]?.id
  if (!artist) return { songs: [] }
  const popular = shuffle(topSongsOf(await artistOverview(artist))).filter((song) => song.id !== track.id)
  return { songs: [track, ...popular] }
}

const queue = {
  async start({ playlistId }: { playlistId?: string }): Promise<QueuePage> {
    const value = String(playlistId)
    if (value.startsWith('artist-shuffle:')) {
      return { songs: shuffle(topSongsOf(await artistOverview(value.slice('artist-shuffle:'.length)))) }
    }
    if (value.startsWith('artist-radio:')) {
      const [first] = topSongsOf(await artistOverview(value.slice('artist-radio:'.length)))
      if (!first) return { songs: [] }
      const radio = await radioFromSong(first)
      return { songs: [first, ...radio.songs.filter((song) => song.id !== first.id)] }
    }
    if (String(value).split(':')[1] === 'playlist') return { songs: (await getPlaylist({ id: value })).songs }
    return { songs: [] }
  },
  // Radios are a fixed shuffle of what Spotify says; no continuations.
  async more(): Promise<QueuePage> {
    return { songs: [] }
  },
  async radio(seed: RadioSeed): Promise<QueuePage> {
    if (seed.kind === 'song') return radioFromSong(seed.song)
    const page = seed.kind === 'album' ? await getAlbum({ id: seed.album.id }) : await getPlaylist({ id: seed.playlist.id })
    const [first] = page.songs
    if (!first) return { songs: [] }
    const radio = await radioFromSong(first)
    return { songs: [first, ...radio.songs.filter((song) => song.id !== first.id)] }
  },
}

/* ------------------------------------------------------------------ *
 * Library and likes (signed in)
 * ------------------------------------------------------------------ */

async function libraryItems(filter: string): Promise<Item[]> {
  const items: Item[] = []
  for (let offset = 0; offset < 400; offset += 50) {
    const page = (
      await gql('libraryV3', {
        filters: [filter],
        order: null,
        textFilter: null,
        features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'PRERELEASES_V2', 'EVENTS'],
        limit: 50,
        offset,
        flatten: true,
        folderUri: null,
        includeFoldersWhenFlattening: true,
      })
    )?.me?.libraryV3
    items.push(...toItems((page?.items ?? []).map((entry: Raw) => entry?.item ?? entry)))
    if (!page || offset + 50 >= (page.totalCount ?? 0)) break
  }
  return items
}

let likedOffset = 0

async function likedPage(offset: number): Promise<{ songs: Song[]; hasMore: boolean }> {
  const tracks = (await gql('fetchLibraryTracks', { offset, limit: 50 }))?.me?.library?.tracks
  likedOffset = offset + 50
  return {
    songs: compact((tracks?.items ?? []).map((entry: Raw) => toSong(unwrap(entry?.track ?? entry)))),
    hasMore: likedOffset < (tracks?.totalCount ?? 0),
  }
}

const library = {
  playlists: async () => (await libraryItems('Playlists')).filter((item) => item.type === 'playlist'),
  artists: async () => (await libraryItems('Artists')).filter((item) => item.type === 'artist'),
  liked: () => likedPage(0),
  likedMore: () => likedPage(likedOffset),
  async like({ song, liked }: { song: Song; liked: boolean }) {
    if (liked) await gql('addToLibrary', { libraryItemUris: [song.id], interactionId: null })
    else await gql('removeFromLibrary', { libraryItemUris: [song.id] })
  },
}

/* ------------------------------------------------------------------ *
 * Signing in: Spotify's own login page; its cookies upgrade the next session
 * ------------------------------------------------------------------ */

async function afterSignIn() {
  await refreshProfile()
  notify(`Signed in to Spotify as ${me.value?.name ?? 'you'}`)
  if (Noctis.activeService.value?.id !== SOURCE) {
    ui.confirm({
      title: 'Use Spotify?',
      message: 'Show your Spotify home, search and library instead of the current service? You can switch back in Settings → Content.',
      confirmLabel: 'Use Spotify',
      onConfirm: () => {
        Noctis.activeServiceId.value = SOURCE
      },
    })
  }
}

/** Whether anything native can sign in at all (the browser falls back to cookies). */
const canSignInNatively = Noctis.libs.auth.canCaptureWeb

/** Spotify's login page, then the web player in a WebView mints the token (see captureSession). */
async function signInInApp() {
  await captureSession({ signIn: true })
}

function pasteCookies() {
  Noctis.libs.ui.showTextDialog({
    title: 'Sign in with cookies',
    description: 'In a desktop browser: open open.spotify.com → DevTools → Network → any request → copy the whole Cookie line (sp_dc alone is enough)',
    placeholder: 'sp_dc=…; sp_t=…; …',
    multiline: true,
    confirmLabel: 'Sign in',
    async onConfirm(pasted) {
      if (!String(pasted ?? '').trim()) {
        notify('No cookies pasted')
        return
      }
      try {
        await signInWithCookies(pasted)
        await afterSignIn()
        notify(`Signed in as ${me.value?.name ?? 'you'}`)
      } catch (error) {
        notify((error as Error).message)
      }
    },
  })
}

/** The end of the ladder: when Spotify refuses to mint from a whole network
 * (proxy exits and similar), a valid token still works — copy one out of a
 * browser that does reach Spotify. */
function pasteToken() {
  Noctis.libs.ui.showTextDialog({
    title: 'Use a token from your browser',
    description: [
      'Spotify refuses to mint tokens for your network (usually a shared proxy), but a real browser gets one:',
      '1. In your normal browser open open.spotify.com, press F12 → Network',
      '2. Reload, click the api/token request that returned 200 (or search "token" in the filter)',
      '3. Select the Response tab and copy everything (the whole JSON is fine)',
    ].join('\n'),
    placeholder: 'Paste the whole request response, or just the token',
    multiline: true,
    confirmLabel: 'Use it',
    async onConfirm(pasted) {
      if (!String(pasted ?? '').trim()) {
        notify('Nothing pasted')
        return
      }
      try {
        await signInWithToken(pasted)
        await afterSignIn()
        notify(me.value ? `Signed in as ${me.value.name}` : 'Using Spotify anonymously')
      } catch (error) {
        notify((error as Error).message)
      }
    },
  })
}

/** Runs a sign-in flow and celebrates it (the UI reports the reason it didn't complete). */
async function completeSignIn(run: () => Promise<unknown>) {
  try {
    await run()
    await afterSignIn()
  } catch (error) {
    // sign-in windows sometimes reject with a plain string; don't log "undefined"
    const message = String((error as { message?: string } | null)?.message ?? error ?? 'unknown error')
    Noctis.writeLog(SOURCE, 'warn', `[auth] Sign-in stopped: ${message}`)
    if (!/closed|cancel/i.test(message)) notify(message)
    return false
  }
  if (Noctis.activeService.value?.id === SOURCE) notify(`Signed in as ${me.value?.name ?? 'you'}`)
  return true
}

/** Settings → Accounts asks first. */
async function signOut() {
  for (const site of ['https://open.spotify.com', 'https://accounts.spotify.com', 'https://www.spotify.com']) {
    await auth.clearSiteCookies(site)
  }
  setMe(null)
  setSession(null)
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

const service: ServiceDefinition = {
  name: 'Spotify',
  icon: 'music',
  home: { load: loadHome },
  search: {
    filters: [
      { id: 'song', label: 'Songs' },
      { id: 'album', label: 'Albums' },
      { id: 'artist', label: 'Artists' },
      { id: 'playlist', label: 'Playlists' },
    ],
    query: searchQuery,
    more: searchMore,
    suggestions,
  },
  albums: { get: getAlbum },
  playlists: { get: getPlaylist, more: morePlaylist },
  artists: { get: getArtist },
  queue,
  get library() {
    return signedIn.value ? library : undefined
  },
  streams: { resolve: resolveStream },
  links: {
    share(item) {
      const [, type, id] = item.id.split(':')
      return type && id ? `https://open.spotify.com/${type}/${id}` : undefined
    },
  },
  account: {
    get signedIn() {
      return signedIn.value
    },
    get info() {
      return me.value ? { name: me.value.name, handle: 'Spotify', photo: me.value.photo } : null
    },
    get sessionKey() {
      return me.value?.id ?? 'guest'
    },
    section: SOURCE,
    signInTitle: 'Sign in to Spotify',
    signInDescription: 'Your playlists, liked songs and personal mixes',
    refresh: refreshProfile,
    // Offered in Settings → Accounts.
    signInMethods: [
      {
        id: 'web',
        label: 'Sign in to Spotify',
        description: 'Your playlists, liked songs and personal mixes',
        get hidden() {
          return !canSignInNatively
        },
        run: () => completeSignIn(signInInApp),
      },
      {
        id: 'cookies',
        icon: 'cookie',
        label: 'Sign in with cookies',
        description: 'Advanced fallback: paste open.spotify.com cookies from any desktop browser',
        run: pasteCookies,
      },
      {
        id: 'token',
        icon: 'vpn_key',
        label: 'Use a token from your browser',
        description: 'When Spotify refuses every mint from your network (usually a shared proxy), paste a token taken from a working browser',
        run: pasteToken,
      },
    ],
    signOut,
  },
}

/* ------------------------------------------------------------------ *
 * Song menu: hand a song a fresh stream when one goes bad
 * ------------------------------------------------------------------ */

const isSpotifySong = (context: unknown) => {
  const item = (context as { item?: Item | null })?.item
  return item?.type === 'song' && item.source === SOURCE
}

const reloadAudioEntry = { id: 'spotify-reload-audio', icon: 'refresh', label: 'Reload audio', action: 'spotify.reloadAudio', visible: isSpotifySong }

/* ------------------------------------------------------------------ *
 * Settings → Spotify
 * ------------------------------------------------------------------ */

const SECTION = {
  id: SOURCE,
  icon: 'music',
  title: 'Spotify',
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
          return signedIn.value ? `Signed in as ${me.value?.name ?? 'you'}` : 'Not signed in • sign in'
        },
        chevron: true,
        onClick: () => void Noctis.libs.navigation.navigate({ name: 'settings-page', page: 'accounts' }),
      },
    ]),
    {
      id: 'session-note',
      type: 'note',
      text: 'Without signing in you can still browse and search Spotify, but playback needs an account (anonymous sessions get 30-second previews at most). Sign-in happens in the Android or desktop app; in the browser paste cookies instead. Noctis uses Spotify the way its web player does, which Spotify doesn\'t officially support; it may stop working until the plugin is updated.',
    },
    { id: 'audio-header', type: 'header', title: 'Audio' },
    Noctis.group('audio', [
      {
        id: 'prefer-clear',
        icon: 'link',
        title: 'Prefer the clear MP3',
        description:
          "Plays Spotify's clear MP3 instead of the DRM-protected rendition (which Widevine decrypts). The clear MP3 is also the only kind downloads and the cache can save",
        toggle: {
          get value() {
            return preferClear.value
          },
          set(value: boolean) {
            setPreferClear(value, Plugin.storage)
          },
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
        id: 'operations',
        icon: 'sync',
        title: 'Refresh Spotify operations',
        get description() {
          return operations.value
            ? `${Object.keys(operations.value.hashes ?? {}).length} known • read ${new Date(operations.value.at).toLocaleDateString()}`
            : 'Not read yet'
        },
        async onClick() {
          await ensureOperations(true)
          notify('Spotify operations refreshed')
        },
      },
    ]),
    {
      id: 'audio-note',
      type: 'note',
      text: 'Audio comes from Spotify itself, the way its web player plays it: an MP3 from its file servers, or the DRM-protected MP4/FLAC that Widevine decrypts (devices without a content decryption module get the MP3). Only the MP3 can be downloaded — protected files never leave the decryption module decrypted.',
    },
  ])
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export default function spotify({ Plugin }: PluginScope) {
  initSession(Plugin.storage)
  initStreamPrefs(Plugin.storage)

  const attach = () => {
    Plugin.defineService(SOURCE, service)
    Noctis.ActionCollections.songMenu.push(reloadAudioEntry)
    Plugin.registerAction('spotify.reloadAudio', ({ item }: { item?: Item }) => {
      if (item) Noctis.libs.stream.forgetStream(item.id)
      notify('The song gets a fresh stream the next time it plays')
    })
    defineSettings(Plugin)
    // Warm the session, the client token and the operation hashes in the background.
    void accessToken().catch(() => {})
    void ensureOperations().catch(() => {})
    void emeAvailable().catch(() => {})
  }

  const detach = () => {
    Plugin.removeService(SOURCE)
    Plugin.unregisterAction('spotify.reloadAudio')
    const menu = Noctis.ActionCollections.songMenu
    const entry = menu.find((row) => row.id === reloadAudioEntry.id)
    if (entry) menu.splice(menu.indexOf(entry), 1)
    Plugin.removeSection(SECTION.id)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
