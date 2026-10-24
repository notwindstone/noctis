/*
 * Spotify for Noctis (see docs/PLUGINS.md).
 *
 * Spotify's public Web API now needs a Premium developer account, so this plugin talks
 * to Spotify the way its web player does:
 *
 * - The session: a hidden open.spotify.com page (Noctis.libs.auth.captureWebResponse)
 *   runs Spotify's own code to get an access token. Signing in is a normal Spotify
 *   login page; its cookies make the next token a signed-in one. Without signing in
 *   you still get an anonymous session: home, search, albums, artists and playlists.
 * - The data: the web player's GraphQL API (api-partner.spotify.com/pathfinder). Its
 *   operations are identified by hashes, read from the web player's own scripts, so a
 *   Spotify update doesn't need a plugin update.
 * - The audio: Spotify's is DRM-protected, so each track is matched on YouTube Music
 *   and played from there, through the YouTube Music service.
 *
 * This is unofficial: Spotify can change any of it. Everything runs in the Android app
 * (the browser can't host the hidden web player).
 */

const { Plugin, Noctis } = scopedThis
const { ref, computed } = Noctis.packages.vue
const { notify } = Noctis.libs.snackbar
const { auth, http, ui } = Noctis.libs

const SOURCE = 'spotify'
const YTM = 'youtube-music'
const WEB_PLAYER = 'https://open.spotify.com/'
const GRAPHQL = 'https://api-partner.spotify.com/pathfinder/v2/query'
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** Hashes seen in October 2026, used until (or if) discovery from the web player fails. */
const KNOWN_OPERATIONS = {
  home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
  searchDesktop: 'eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03',
  searchTracks: 'b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751',
  searchAlbums: '202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9',
  searchArtists: '7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d',
  searchPlaylists: 'd520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1',
  searchSuggestions: 'f244254b94c0e824d458ac216e0f8406a73f2f69a9ff52831a2f78fa774ff6ce',
  getAlbum: '0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f',
  queryArtistOverview: '9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6',
  fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
  fetchPlaylistContents: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
  addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
}

/* ------------------------------------------------------------------ *
 * State (kept with Plugin.storage)
 * ------------------------------------------------------------------ */

/** { token, expiresAt, anonymous } — the web player's access token. */
const session = ref(Plugin.storage.get('session', null))
/** { id, name, photo } once signed in; null for the anonymous session. */
const me = ref(Plugin.storage.get('me', null))
/** Spotify track id → the YouTube Music song that plays it. */
const matches = ref(Plugin.storage.get('matches', {}))
/** Random id the home feed asks for (the web player keeps one per browser). */
const deviceId = Plugin.storage.get('device', null) ?? crypto.randomUUID()
Plugin.storage.set('device', deviceId)

const signedIn = computed(() => me.value !== null)

function setSession(value) {
  session.value = value
  if (value) Plugin.storage.set('session', value)
  else Plugin.storage.remove('session')
}

function setMe(value) {
  me.value = value
  if (value) Plugin.storage.set('me', value)
  else Plugin.storage.remove('me')
}

let saveMatchesTimer = 0
function rememberMatch(trackId, song) {
  const next = { ...matches.value, [trackId]: song }
  const keys = Object.keys(next)
  // Keep the most recent 3000.
  for (const key of keys.slice(0, Math.max(0, keys.length - 3000))) delete next[key]
  matches.value = next
  window.clearTimeout(saveMatchesTimer)
  saveMatchesTimer = window.setTimeout(() => Plugin.storage.set('matches', matches.value), 500)
}

/** A URL without its query and fragment (they can carry one-time codes). */
const redactUrl = (url) => String(url ?? '').replace(/[?#].*$/, (rest) => (rest.length > 1 ? '?…' : ''))

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

const settled = async (promise) => {
  try {
    return await promise
  } catch (error) {
    Plugin.warn(error.message)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Session: the web player's token, captured from a hidden open.spotify.com
 * ------------------------------------------------------------------ */

let capturing = null

async function captureSession() {
  if (!auth.canCaptureWeb) {
    throw new Error('Spotify works in the Android app: it borrows the session of a hidden Spotify web player.')
  }
  Plugin.log('[auth] Capturing a session from the hidden web player…')
  const started = Date.now()
  let captured
  try {
    captured = await auth.captureWebResponse({ url: WEB_PLAYER, match: '/api/token', userAgent: DESKTOP_UA, timeoutMs: 40_000 })
  } catch (error) {
    Plugin.error(`[auth] Capture failed after ${Date.now() - started} ms: ${error.message}`)
    throw error
  }
  let json
  try {
    json = JSON.parse(captured.body)
  } catch {
    Plugin.error(`[auth] Token response isn't JSON (${captured.body.length} chars): ${captured.body.slice(0, 200)}`)
    throw new Error("Spotify didn't hand out a session")
  }
  // Never log the token itself: only its shape.
  Plugin.log(
    `[auth] Captured ${redactUrl(captured.url)} in ${Date.now() - started} ms: ` +
      `anonymous=${json.isAnonymous}, token=${json.accessToken ? `${json.accessToken.length} chars` : 'missing'}, ` +
      `clientId=${json.clientId ?? '?'}, expires in ${json.accessTokenExpirationTimestampMs ? Math.round((json.accessTokenExpirationTimestampMs - Date.now()) / 60_000) : '?'} min, ` +
      `other keys: ${Object.keys(json).filter((key) => !['accessToken', 'isAnonymous', 'clientId', 'accessTokenExpirationTimestampMs'].includes(key)).join(', ') || 'none'}`,
  )
  if (!json.accessToken) throw new Error("Spotify didn't hand out a session")
  setSession({
    token: json.accessToken,
    expiresAt: (json.accessTokenExpirationTimestampMs ?? Date.now() + 3_600_000) - 120_000,
    anonymous: Boolean(json.isAnonymous),
  })
  // Signed out elsewhere (or the cookies expired): fall back to the anonymous session.
  if (json.isAnonymous && me.value) {
    setMe(null)
    Plugin.warn('The Spotify sign-in expired; continuing without an account')
  }
  return session.value
}

async function accessToken({ fresh = false } = {}) {
  const current = session.value
  if (!fresh && current?.token && current.expiresAt > Date.now()) return current.token
  capturing ??= captureSession().finally(() => {
    capturing = null
  })
  return (await capturing).token
}

/* ------------------------------------------------------------------ *
 * Operations: hashes read from the web player's scripts
 * ------------------------------------------------------------------ */

const OPERATION = /"(\w+)","(?:query|mutation)","([0-9a-f]{64})"/g
let operations = Plugin.storage.get('operations', null)
let discovering = null

async function text(url) {
  const response = await http.request(url, { headers: { 'user-agent': DESKTOP_UA } })
  if (response.status !== 200 || typeof response.data !== 'string') throw new Error(`HTTP ${response.status} for ${url}`)
  return response.data
}

/** Read every operation hash from the web player bundle and its search chunk. */
async function discoverOperations() {
  const html = await text(WEB_PLAYER)
  const bundle = html.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[0-9a-f]+\.js/)?.[0]
  if (!bundle) throw new Error('web player bundle not found')
  const main = await text(bundle)
  const found = {}
  for (const [, name, hash] of main.matchAll(OPERATION)) found[name] ??= hash

  // Search lives in a lazily loaded chunk: find its file name in the chunk map.
  const chunkId = main.match(/(\d+):"xpui-routes-search"/)?.[1]
  if (chunkId) {
    const base = bundle.slice(0, bundle.lastIndexOf('/') + 1)
    for (const [, hash] of main.matchAll(new RegExp(`[,{]${chunkId}:"([0-9a-f]{8})"`, 'g'))) {
      const chunk = await settled(text(`${base}xpui-routes-search.${hash}.js`))
      if (!chunk) continue
      for (const [, name, opHash] of chunk.matchAll(OPERATION)) found[name] ??= opHash
      break
    }
  }
  const appVersion = main.match(/"spotify-app-version",value:"(\d+)"/)?.[1]
  operations = { hashes: found, appVersion, at: Date.now() }
  Plugin.storage.set('operations', operations)
  Plugin.log(`Found ${Object.keys(found).length} Spotify operations`)
  return operations
}

async function ensureOperations(force = false) {
  const stale = !operations || Date.now() - operations.at > 24 * 3_600_000
  if (force || stale) {
    discovering ??= discoverOperations()
      .catch((error) => {
        Plugin.warn(`Couldn't read Spotify's operations (${error.message}); using known ones`)
        return operations
      })
      .finally(() => {
        discovering = null
      })
    await discovering
  }
  return operations
}

/** Run a GraphQL operation; returns its `data`. */
async function gql(name, variables, attempt = 0) {
  const known = await ensureOperations(attempt === 2)
  const hash = known?.hashes?.[name] ?? KNOWN_OPERATIONS[name]
  if (!hash) throw new Error(`Spotify no longer has "${name}"`)

  const response = await http.request(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await accessToken({ fresh: attempt === 1 })}`,
      // Without it, Android's HTTP client sends "Dalvik/…", which Spotify answers with
      // 403 "Client/request not allowed".
      'user-agent': DESKTOP_UA,
      'app-platform': 'WebPlayer',
      ...(known?.appVersion ? { 'spotify-app-version': known.appVersion } : {}),
      accept: 'application/json',
      'content-type': 'application/json;charset=UTF-8',
    },
    body: { variables, operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
  })

  const json = typeof response.data === 'object' && response.data !== null ? response.data : {}
  const message = json.errors?.[0]?.message ?? ''
  if (response.status >= 400 || !json.data) {
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    Plugin.warn(
      `[gql] ${name} (attempt ${attempt}) → HTTP ${response.status}; session anonymous=${session.value?.anonymous}, ` +
        `appVersion=${known?.appVersion ?? 'none'}, hash ${known?.hashes?.[name] ? 'discovered' : 'built-in'}; ` +
        `www-authenticate=${response.headers['www-authenticate'] ?? '-'}; body: ${body.slice(0, 300)}`,
    )
  }
  if (response.status === 401 && attempt === 0) return gql(name, variables, 1)
  if (/PersistedQueryNotFound/i.test(message) && attempt < 2) return gql(name, variables, 2)
  if (response.status === 429 && attempt < 3) {
    await sleep(Math.min(Number(response.headers['retry-after']) || 2, 10) * 1000)
    return gql(name, variables, 3)
  }
  if (response.status >= 400 || !json.data) throw new Error(`Spotify: ${message || `HTTP ${response.status}`}`)
  return json.data
}

/* ------------------------------------------------------------------ *
 * Sign-in: Spotify's own login page; its cookies upgrade the next session
 * ------------------------------------------------------------------ */

async function refreshProfile() {
  if (session.value?.anonymous !== false) return null
  const data = await gql('profileAttributes', {})
  const profile = data?.me?.profile
  Plugin.log(`[auth] Profile: ${profile ? `found (${profile.name ? 'has name' : 'no name'})` : `missing; data keys: ${Object.keys(data ?? {}).join(', ')}`}`)
  if (!profile) return null
  setMe({ id: profile.username ?? profile.uri, name: profile.name || profile.username, photo: largest(profile.avatar?.sources) })
  return me.value
}

async function signIn() {
  if (!auth.canCaptureWeb) {
    notify('Signing in to Spotify works in the Android app')
    return
  }
  Plugin.log('[auth] Opening the Spotify sign-in window')
  try {
    const landed = await auth.openAuthWindow({
      url: `https://accounts.spotify.com/login?continue=${encodeURIComponent(WEB_PLAYER)}`,
      redirect: 'https://open.spotify.com',
      title: 'Sign in to Spotify',
    })
    Plugin.log(`[auth] Sign-in window closed at ${redactUrl(landed)}`)
  } catch (error) {
    Plugin.warn(`[auth] Sign-in window: ${error.message}`)
    if (!/cancel/i.test(error.message)) notify(error.message)
    return
  }
  try {
    const fresh = await captureSession()
    if (fresh.anonymous) {
      Plugin.warn('[auth] Signed in, but the web player still handed out an anonymous session (no sign-in cookies?)')
      notify("Spotify didn't keep the sign-in; try again")
      return
    }
    await refreshProfile()
  } catch (error) {
    Plugin.error(`[auth] Sign-in failed: ${error.message}`)
    notify(error.message)
    return
  }
  Plugin.log(`Signed in as ${me.value?.name ?? 'unknown'}`)
  if (Noctis.activeService.value?.id !== SOURCE) {
    ui.confirm({
      title: 'Use Spotify?',
      message: 'Show your Spotify home, search and library instead of the current service? You can switch back in Settings → Content.',
      confirmLabel: 'Use Spotify',
      onConfirm: () => {
        Noctis.activeServiceId.value = SOURCE
      },
    })
  } else {
    notify(`Signed in as ${me.value?.name ?? 'you'}`)
  }
}

function signOut() {
  ui.confirm({
    title: 'Sign out of Spotify?',
    message: 'Likes, downloads and history on this device stay where they are.',
    confirmLabel: 'Sign out',
    destructive: true,
    onConfirm: async () => {
      for (const site of ['https://open.spotify.com', 'https://accounts.spotify.com', 'https://www.spotify.com']) {
        await auth.clearSiteCookies(site)
      }
      setMe(null)
      setSession(null)
      notify('Signed out of Spotify')
    },
  })
}

/* ------------------------------------------------------------------ *
 * Mapping. GraphQL wraps entities in data/item/itemV2/content/track; every
 * entity has a URI ("spotify:track:…"), used as the Noctis id as it is.
 * ------------------------------------------------------------------ */

const idOf = (value) => String(value).split(':').pop()
const typeOf = (uri) => String(uri ?? '').split(':')[1]
const compact = (list) => list.filter(Boolean)

/** The entity inside a wrapper, or null. */
function unwrap(node) {
  let current = node
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    if (current._uri && current.data && !current.data.uri) return { ...current.data, uri: current._uri }
    const inner = current.data ?? current.content ?? current.itemV2 ?? current.item ?? current.track
    if (inner && typeof inner === 'object') {
      current = inner
      continue
    }
    break
  }
  return current?.uri ? current : null
}

function largest(sources) {
  if (!sources?.length) return undefined
  return [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url
}

const imageOf = (entity) =>
  largest(entity?.coverArt?.sources) ??
  largest(entity?.visuals?.avatarImage?.sources) ??
  largest(entity?.images?.items?.[0]?.sources) ??
  largest(entity?.albumOfTrack?.coverArt?.sources)

const artistRefs = (artists) =>
  (artists?.items ?? []).map((artist) => ({ id: artist.uri, name: artist.profile?.name ?? artist.name ?? '' })).filter((artist) => artist.name)

const yearOf = (date) => (date?.year ? String(date.year) : date?.isoString?.slice(0, 4))
const KIND = { ALBUM: 'Album', SINGLE: 'Single', EP: 'EP', COMPILATION: 'Compilation' }

function formatCount(value) {
  const number = Number(value)
  if (!number) return ''
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}K`
  return String(number)
}

const plainText = (html) =>
  html ? new DOMParser().parseFromString(html.replace(/<[^>]+>/g, ''), 'text/html').documentElement.textContent?.trim() || undefined : undefined

function toSong(track, album) {
  if (!track || typeOf(track.uri) !== 'track') return null
  const owner = track.albumOfTrack ?? album
  const ms = track.duration?.totalMilliseconds ?? track.trackDuration?.totalMilliseconds
  return {
    type: 'song',
    source: SOURCE,
    id: track.uri,
    title: track.name,
    artists: artistRefs(track.artists ?? track.firstArtist),
    album: owner?.uri ? { id: owner.uri, name: owner.name } : undefined,
    duration: ms ? Math.round(ms / 1000) : undefined,
    thumbnail: imageOf(owner) ?? imageOf(track),
    explicit: track.contentRating?.label === 'EXPLICIT' || undefined,
  }
}

function toAlbum(album) {
  if (!album || typeOf(album.uri) !== 'album') return null
  return {
    type: 'album',
    source: SOURCE,
    id: album.uri,
    title: album.name,
    artists: artistRefs(album.artists),
    year: yearOf(album.date),
    thumbnail: imageOf(album),
    kind: KIND[album.type] ?? 'Album',
  }
}

function toArtist(artist) {
  if (!artist || typeOf(artist.uri) !== 'artist') return null
  return { type: 'artist', source: SOURCE, id: artist.uri, name: artist.profile?.name ?? artist.name, subtitle: 'Artist', thumbnail: imageOf(artist) }
}

function toPlaylist(playlist) {
  if (!playlist || typeOf(playlist.uri) !== 'playlist') return null
  const owner = playlist.ownerV2?.data?.name
  return { type: 'playlist', source: SOURCE, id: playlist.uri, title: playlist.name, subtitle: owner ? `Playlist • ${owner}` : 'Playlist', thumbnail: imageOf(playlist) }
}

/** Any wrapped entity → a Noctis item. */
function toItem(node) {
  const entity = unwrap(node)
  switch (typeOf(entity?.uri)) {
    case 'track':
      return toSong(entity)
    case 'album':
      return toAlbum(entity)
    case 'artist':
      return toArtist(entity)
    case 'playlist':
      return toPlaylist(entity)
  }
  return null
}

const toItems = (nodes) => compact((nodes ?? []).map(toItem))
const section = (id, title, items, layout = 'carousel', extra = {}) => (items.length > 0 ? { id, title, layout, items, ...extra } : null)

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */

/** Chip label → facet id, from the last home response. */
let homeFacets = {}

async function loadHome({ filter }) {
  const data = await gql('home', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sp_t: deviceId,
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

  const sections = compact(
    (home?.sectionContainer?.sections?.items ?? []).map((entry, index) => {
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
const SEARCH_BY_TYPE = {
  song: ['searchTracks', 'tracksV2'],
  album: ['searchAlbums', 'albumsV2'],
  artist: ['searchArtists', 'artists'],
  playlist: ['searchPlaylists', 'playlists'],
}
const PAGE = 20
let searchOffset = 0

async function searchQuery({ query, type }) {
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
  const without = (items) => items.filter((item) => item.id !== topId)
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

async function searchMore({ query, type }) {
  const filtered = SEARCH_BY_TYPE[type]
  if (!filtered) return { items: [], hasMore: false }
  const [operation, key] = filtered
  const data = await gql(operation, { ...SEARCH_FLAGS, searchTerm: query, offset: searchOffset, limit: PAGE, numberOfTopResults: PAGE })
  const page = data?.searchV2?.[key]
  searchOffset += PAGE
  return { items: toItems(page?.items), hasMore: searchOffset < (page?.totalCount ?? 0) }
}

async function suggestions({ input }) {
  if (input.trim().length < 2) return { queries: [], items: [] }
  const data = await gql('searchSuggestions', {
    query: input,
    limit: 10,
    numberOfTopResults: 10,
    offset: 0,
    includeAuthors: false,
    includeAlbumPreReleases: false,
    includeEpisodeContentRatingsV2: false,
  })
  const queries = []
  const items = []
  for (const entry of data?.searchV2?.topResultsV2?.itemsV2 ?? []) {
    const entity = entry?.item?.data ?? entry?.data
    // Text suggestions are spotify:search:… entities with a `text`.
    if (entity?.text && typeOf(entity.uri) === 'search') queries.push(entity.text)
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

async function getAlbum({ id }) {
  const first = (await gql('getAlbum', { uri: id, locale: '', offset: 0, limit: 50 }))?.albumUnion
  if (!first || first.__typename !== 'Album') throw new Error('This album is not available')
  const entries = [...(first.tracksV2?.items ?? [])]
  const total = first.tracksV2?.totalCount ?? entries.length
  while (entries.length < total && entries.length < 500) {
    const page = (await gql('getAlbum', { uri: id, locale: '', offset: entries.length, limit: 50 }))?.albumUnion?.tracksV2?.items ?? []
    if (page.length === 0) break
    entries.push(...page)
  }
  const songs = compact(entries.map((entry) => toSong(unwrap(entry), first)))
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
const playlistOffsets = new Map()
const PLAYLIST_PAGE = 100
const playlistSongs = (items) => compact((items ?? []).map((entry) => toSong(unwrap(entry?.itemV2 ?? entry))))

async function getPlaylist({ id }) {
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

async function morePlaylist({ id }) {
  const offset = playlistOffsets.get(id) ?? PLAYLIST_PAGE
  const content = (await gql('fetchPlaylistContents', { uri: id, offset, limit: PLAYLIST_PAGE, includeEpisodeContentRatingsV2: false }))?.playlistV2
    ?.content
  playlistOffsets.set(id, offset + PLAYLIST_PAGE)
  return { songs: playlistSongs(content?.items), hasMore: offset + PLAYLIST_PAGE < (content?.totalCount ?? 0) }
}

async function artistOverview(id) {
  const artist = (await gql('queryArtistOverview', { uri: id, locale: '', preReleaseV2: false }))?.artistUnion
  if (!artist || artist.__typename !== 'Artist') throw new Error('This artist is not available')
  return artist
}

const topSongsOf = (artist) => compact((artist.discography?.topTracks?.items ?? []).map((entry) => toSong(unwrap(entry))))
const releases = (group) => toItems((group?.items ?? []).map((entry) => entry?.releases?.items?.[0] ?? entry))

async function getArtist({ id }) {
  const artist = await artistOverview(id)
  const top = topSongsOf(artist)
  const listeners = formatCount(artist.stats?.monthlyListeners)
  const bio = plainText(artist.profile?.biography?.text)
  return {
    id,
    name: artist.profile?.name ?? '',
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
      section('playlists', `Featuring ${artist.profile?.name ?? ''}`.trim(), toItems(artist.relatedContent?.featuringV2?.items)),
      section('related', 'Fans also like', toItems(artist.relatedContent?.relatedArtists?.items)),
    ]),
  }
}

/* ------------------------------------------------------------------ *
 * Library and likes (signed in)
 * ------------------------------------------------------------------ */

async function libraryItems(filter) {
  const items = []
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
    items.push(...toItems((page?.items ?? []).map((entry) => entry?.item ?? entry)))
    if (!page || offset + 50 >= (page.totalCount ?? 0)) break
  }
  return items
}

let likedOffset = 0

async function likedPage(offset) {
  const tracks = (await gql('fetchLibraryTracks', { offset, limit: 50 }))?.me?.library?.tracks
  likedOffset = offset + 50
  return { songs: compact((tracks?.items ?? []).map((entry) => toSong(unwrap(entry?.track ?? entry)))), hasMore: likedOffset < (tracks?.totalCount ?? 0) }
}

const library = {
  playlists: async () => (await libraryItems('Playlists')).filter((item) => item.type === 'playlist'),
  artists: async () => (await libraryItems('Artists')).filter((item) => item.type === 'artist'),
  liked: () => likedPage(0),
  likedMore: () => likedPage(likedOffset),
  async like({ song, liked }) {
    if (liked) await gql('addToLibrary', { libraryItemUris: [song.id], interactionId: null })
    else await gql('removeFromLibrary', { libraryItemUris: [song.id] })
  },
}

/* ------------------------------------------------------------------ *
 * Audio: match on YouTube Music
 * ------------------------------------------------------------------ */

function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((feat|ft|with)\.?[^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s-\s.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|radio)\b.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function overlap(a, b) {
  const left = new Set(normalize(a).split(' ').filter(Boolean))
  const right = new Set(normalize(b).split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / Math.max(left.size, right.size)
}

function score(track, candidate) {
  const title = overlap(track.title, candidate.title)
  const wanted = track.artists.map((artist) => normalize(artist.name))
  const got = normalize(candidate.artists.map((artist) => artist.name).join(' '))
  const artist = wanted.some((name) => name && got.includes(name)) ? 1 : overlap(wanted.join(' '), got)
  const difference = track.duration && candidate.duration ? Math.abs(track.duration - candidate.duration) : 30
  const duration = Math.max(0, 1 - difference / 20)
  return title * 0.45 + artist * 0.3 + duration * 0.25 - (candidate.isVideo ? 0.05 : 0)
}

/** One more try after a short pause: a dropped connection shouldn't stop a song. */
async function retry(task) {
  try {
    return await task()
  } catch {
    await sleep(800)
    return task()
  }
}

function requireYouTubeMusic() {
  if (!Noctis.services[YTM]) {
    throw new Error('Spotify songs play through YouTube Music. Turn it on in Settings → Plugins.')
  }
}

/** YouTube Music songs that could be this track, best first. */
async function candidatesFor(track) {
  requireYouTubeMusic()
  const query = `${track.title} ${track.artists[0]?.name ?? ''}`.trim()
  const songs = await retry(() => Noctis.api.request(YTM, 'search.query', { query, type: 'song' }))
  let candidates = songs.items.filter((item) => item.type === 'song')
  if (candidates.length === 0 || Math.max(...candidates.map((item) => score(track, item))) < 0.5) {
    const videos = await settled(Noctis.api.request(YTM, 'search.query', { query, type: 'video' }))
    candidates = [...candidates, ...(videos?.items ?? []).filter((item) => item.type === 'song')]
  }
  return candidates
    .map((candidate) => ({ candidate, score: score(track, candidate) }))
    .sort((a, b) => b.score - a.score)
}

const pending = new Map()

async function matchFor(track) {
  const known = matches.value[idOf(track.id)]
  if (known) return known
  if (pending.has(track.id)) return pending.get(track.id)

  const task = (async () => {
    const ranked = await candidatesFor(track)
    if (ranked.length === 0) throw new Error(`"${track.title}" wasn't found on YouTube Music.`)
    const best = ranked[0]
    if (best.score < 0.4) Plugin.warn(`Weak match for "${track.title}": "${best.candidate.title}" (${best.score.toFixed(2)})`)
    const { id, title, artists, duration, isVideo, thumbnail } = best.candidate
    const match = { type: 'song', id, title, artists, duration, isVideo, thumbnail }
    rememberMatch(idOf(track.id), match)
    return match
  })().finally(() => pending.delete(track.id))
  pending.set(track.id, task)
  return task
}

async function resolveStream({ song, efficient }) {
  const match = await matchFor(song)
  return Noctis.api.request(YTM, 'streams.resolve', { song: match, efficient })
}

/* ------------------------------------------------------------------ *
 * Queues. Radios come from YouTube Music, seeded with the matched song; the
 * songs in them are YouTube Music's.
 * ------------------------------------------------------------------ */

async function radioFromSong(track) {
  requireYouTubeMusic()
  const match = await matchFor(track)
  const page = await Noctis.api.request(YTM, 'queue.radio', { kind: 'song', song: match })
  return { ...page, songs: page.songs.filter((item) => item.id !== match.id) }
}

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const queue = {
  async start({ playlistId }) {
    const value = String(playlistId)
    if (value.startsWith('artist-shuffle:')) return { songs: shuffle(topSongsOf(await artistOverview(value.slice('artist-shuffle:'.length)))) }
    if (value.startsWith('artist-radio:')) {
      const [first] = topSongsOf(await artistOverview(value.slice('artist-radio:'.length)))
      if (!first) return { songs: [] }
      const radio = await radioFromSong(first)
      return { ...radio, songs: [first, ...radio.songs] }
    }
    if (typeOf(value) === 'playlist') return { songs: (await getPlaylist({ id: value })).songs }
    return { songs: [] }
  },
  // Continuations belong to the YouTube Music radio.
  more: (input) => Noctis.api.request(YTM, 'queue.more', input),
  async radio(seed) {
    if (seed.kind === 'song') return radioFromSong(seed.song)
    const page = seed.kind === 'album' ? await getAlbum({ id: seed.album.id }) : await getPlaylist({ id: seed.playlist.id })
    const [first] = page.songs
    if (!first) return { songs: [] }
    const radio = await radioFromSong(first)
    return { ...radio, songs: [first, ...radio.songs] }
  },
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

const service = {
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
    section: 'spotify',
    signInTitle: 'Sign in to Spotify',
    signInDescription: 'Your playlists, liked songs and personal mixes',
    refresh: refreshProfile,
  },
}

/* ------------------------------------------------------------------ *
 * Song menu: pick the audio by hand when the match is wrong
 * ------------------------------------------------------------------ */

const isSpotifySong = ({ item }) => item?.type === 'song' && item.source === SOURCE

Plugin.registerAction('spotify.chooseAudio', async ({ item, handlers }) => {
  handlers.pending()
  let ranked
  try {
    ranked = (await candidatesFor(item)).slice(0, 6)
  } catch (error) {
    handlers.error(error.message)
    return
  }
  handlers.reset()
  if (ranked.length === 0) {
    notify('Nothing similar on YouTube Music')
    return
  }
  const current = matches.value[idOf(item.id)]?.id ?? ranked[0].candidate.id
  const time = (seconds) => (seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '')
  ui.showChoice({
    title: 'Play this song from',
    value: current,
    options: ranked.map(({ candidate }) => ({
      value: candidate.id,
      label: candidate.title,
      description: compact([candidate.artists.map((artist) => artist.name).join(', '), time(candidate.duration), candidate.isVideo ? 'Video' : '']).join(' · '),
    })),
    onSelect(value) {
      const chosen = ranked.find(({ candidate }) => candidate.id === value)?.candidate
      if (!chosen) return
      const { id, title, artists, duration, isVideo, thumbnail } = chosen
      rememberMatch(idOf(item.id), { type: 'song', id, title, artists, duration, isVideo, thumbnail })
      Noctis.libs.stream.forgetStream(item.id)
      notify('Audio source changed')
    },
  })
})

const chooseAudioEntry = { id: 'spotify-choose-audio', icon: 'tune', label: 'Choose audio source', action: 'spotify.chooseAudio', visible: isSpotifySong }

/* ------------------------------------------------------------------ *
 * Settings → Spotify
 * ------------------------------------------------------------------ */

const SECTION = {
  id: 'spotify',
  icon: 'music',
  title: 'Spotify',
  get description() {
    return signedIn.value ? `Signed in as ${me.value?.name ?? 'you'}` : 'Not signed in'
  },
}

function defineSettings() {
  Plugin.defineSection(SECTION, [
    Noctis.group('account', [
      {
        id: 'sign-in',
        icon: 'account',
        title: 'Sign in to Spotify',
        description: 'For your playlists, liked songs and personal home',
        onClick: () => void signIn(),
        get hidden() {
          return signedIn.value
        },
      },
      {
        id: 'signed-in',
        icon: 'account',
        get title() {
          return me.value?.name ?? 'Signed in'
        },
        description: 'Spotify account',
        get hidden() {
          return !signedIn.value
        },
      },
      {
        id: 'sign-out',
        icon: 'logout',
        title: 'Sign out',
        destructive: true,
        onClick: signOut,
        get hidden() {
          return !signedIn.value
        },
      },
    ]),
    {
      id: 'session-note',
      type: 'note',
      text: 'Without signing in you can still browse and search Spotify. Noctis uses Spotify the way its web player does, which Spotify doesn\'t officially support; it may stop working until the plugin is updated.',
    },
    { id: 'audio-header', type: 'header', title: 'Audio' },
    Noctis.group('audio', [
      {
        id: 'matches',
        icon: 'sync',
        title: 'Forget matched songs',
        get description() {
          const count = Object.keys(matches.value).length
          return `${count} ${count === 1 ? 'song' : 'songs'} matched to YouTube Music`
        },
        onClick() {
          ui.confirm({
            title: 'Forget matched songs?',
            message: 'Songs will be matched on YouTube Music again the next time they play. Choices made with "Choose audio source" are forgotten too.',
            confirmLabel: 'Forget',
            destructive: true,
            onConfirm() {
              matches.value = {}
              Plugin.storage.remove('matches')
            },
          })
        },
      },
      {
        id: 'operations',
        icon: 'sync',
        title: 'Refresh Spotify operations',
        get description() {
          return operations ? `${Object.keys(operations.hashes ?? {}).length} known · read ${new Date(operations.at).toLocaleDateString()}` : 'Not read yet'
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
      text: 'Spotify doesn\'t let other apps play its audio, so each song is found on YouTube Music and played from there. If one sounds wrong, use "Choose audio source" in its menu.',
    },
  ])
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** Match the next Spotify song while this one plays, so skipping doesn't wait for a search. */
const prefetchNext = ({ index }) => {
  const next = Noctis.libs.player.queue.value[index + 1]
  if (next?.source === SOURCE && Noctis.services[YTM]) void settled(matchFor(next))
}

function attach() {
  Plugin.defineService(SOURCE, service)
  Plugin.subscribe('hook::onPlay::after', prefetchNext)
  Noctis.ActionCollections.songMenu.push(chooseAudioEntry)
  defineSettings()
  void settled(ensureOperations())
}

function detach() {
  Plugin.removeService(SOURCE)
  Plugin.unsubscribe('hook::onPlay::after', prefetchNext)
  const menu = Noctis.ActionCollections.songMenu
  const index = menu.indexOf(chooseAudioEntry)
  if (index !== -1) menu.splice(index, 1)
  Plugin.removeSection(SECTION.id)
}

Plugin.subscribe('lifecycle::disable', detach)
Plugin.subscribe('lifecycle::dirty-enable', attach)
attach()
