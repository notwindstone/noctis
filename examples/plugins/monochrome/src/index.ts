import type { Album, Artist, ArtistPage, ArtistRef, CollectionPage, HomeResult, Item, Playlist, PluginScope, QueuePage, RadioSeed, SearchResult, Section, ServiceDefinition, Song, StreamInfo } from './host'
import { Noctis } from './host'
import { deezerSearch, deezerStream, isDeezer } from './deezer'
import { addInstance, call, hasKind, initInstances, InstanceError, instances, removeInstance, rotation, SUGGESTED, type Instance } from './instances'
import { isTidal, tidalAlbum as tidalAlbumPage, tidalArtist, tidalArtistSongs, tidalImage, tidalSearch, tidalSearchAll, tidalStream, toTidalSong } from './tidal'

/**
 * Monochrome (monochrome.st, github.com/monochrome-music/monochrome) for Noctis:
 * lossless music through the API instances Monochrome uses, which you add yourself
 * (Settings → Monochrome), as in Monochrome's own settings.
 *
 * - A "tracks" instance (tracks.monochrome.st is the official one) has the catalog:
 *   search, albums, artists, and FLAC streams. At least one is needed.
 * - A hifi-api instance adds TIDAL's editorial playlists. Their songs are TIDAL ids,
 *   so each is found on a tracks instance (by ISRC, else title, artist and length) to play,
 *   the way Monochrome's resolveTrackStream does.
 * - Home is Monochrome's editors' picks (monochrome.st/editors-picks.json), found on
 *   the tracks catalog when opened.
 *
 * Also a source for songs from elsewhere (Noctis.libs.matching): a server's MusicBrainz
 * songs, YouTube Music or SoundCloud tracks play in lossless when Monochrome has them.
 */

const SOURCE = 'monochrome'
const { computed, shallowReactive, watch } = Noctis.packages.vue
const { notify } = Noctis.libs.snackbar
const { confirm, showTextDialog } = Noctis.libs.ui
const { StreamError } = Noctis.libs.stream
const { http } = Noctis.libs

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>

const settled = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

const trackId = (id: string) => `${SOURCE}:${id}`
const releaseId = (id: string) => `${SOURCE}:release:${id}`
const artistId = (id: string) => `${SOURCE}:artist:${id}`
const tidalPlaylistId = (uuid: string) => `${SOURCE}:tidal-playlist:${uuid}`
/** An editors' pick: an album named on monochrome.st, found by artist and title when opened. */
const findId = (artist: string, title: string) => `${SOURCE}:find:${encodeURIComponent(artist)}:${encodeURIComponent(title)}`

const rest = (id: string, kind: string) => id.slice(`${SOURCE}:${kind}:`.length)
const rawTrack = (id: string) => id.slice(SOURCE.length + 1)


/* ------------------------------------------------------------------ *
 * The tracks API → Noctis models
 * ------------------------------------------------------------------ */

function artistsOf(item: Raw): ArtistRef[] {
  if (Array.isArray(item.artists) && item.artists.length > 0) {
    return item.artists.map((artist: Raw) => ({ id: artist.artistId || artist.id ? artistId(String(artist.artistId ?? artist.id)) : undefined, name: artist.displayName || artist.name || 'Unknown artist' }))
  }
  const names: string[] = item.artistNames ?? []
  return names.length > 0 ? names.map((name, index) => ({ id: item.artistIds?.[index] ? artistId(String(item.artistIds[index])) : undefined, name })) : [{ name: 'Unknown artist' }]
}

function toSong(track: Raw, release?: Raw): Song {
  const release_ = track.releaseId ?? release?.releaseId
  const album = track.albumTitle ?? track.releaseTitle ?? release?.title
  return {
    type: 'song',
    source: SOURCE,
    id: trackId(String(track.trackId ?? track.id)),
    title: track.title ?? 'Unknown title',
    artists: artistsOf(track.artists || track.artistNames ? track : (release ?? track)),
    album: release_ ? { id: releaseId(String(release_)), name: album ?? '' } : undefined,
    duration: track.duration ? Math.round(track.duration > 10_000 ? track.duration / 1000 : track.duration) : undefined,
    thumbnail: track.artwork || release?.artwork || undefined,
    explicit: Boolean(track.explicit),
  }
}

const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase()

function toAlbum(release: Raw): Album {
  return {
    type: 'album',
    source: SOURCE,
    id: releaseId(String(release.releaseId ?? release.id)),
    title: release.title ?? 'Unknown album',
    artists: artistsOf(release),
    year: release.releaseDate?.slice(0, 4),
    thumbnail: release.artwork || undefined,
    explicit: Boolean(release.explicit),
    kind: release.releaseType ? titleCase(String(release.releaseType)) : 'Album',
  }
}

function toArtist(artist: Raw): Artist {
  return {
    type: 'artist',
    source: SOURCE,
    id: artistId(String(artist.artistId ?? artist.id)),
    name: artist.displayName || artist.name || 'Unknown artist',
    thumbnail: artist.avatar || undefined,
  }
}

function toTidalPlaylist(playlist: Raw): Playlist {
  return {
    type: 'playlist',
    source: SOURCE,
    id: tidalPlaylistId(playlist.uuid),
    title: playlist.title,
    subtitle: ['TIDAL', playlist.numberOfTracks ? `${playlist.numberOfTracks} tracks` : ''].filter(Boolean).join(' · '),
    thumbnail: tidalImage(playlist.squareImage ?? playlist.image, 480),
  }
}

const section = (id: string, title: string, items: Item[], layout: Section['layout'] = 'carousel'): Section[] => (items.length > 0 ? [{ id, title, items, layout }] : [])

/* ------------------------------------------------------------------ *
 * Home: Monochrome's editors' picks
 * ------------------------------------------------------------------ */

async function loadHome(): Promise<HomeResult> {
  if (instances.value.length === 0) throw new InstanceError('Add a Monochrome API instance first: Settings → Monochrome')
  const picks = await settled(http.request('https://monochrome.st/editors-picks.json', { headers: { accept: 'application/json' } }))
  const items = Array.isArray(picks?.data) ? (picks!.data as Raw[]) : []
  const albums = items
    .filter((item) => item.type === 'album' && item.title && item.artist?.name)
    .map(
      (item): Album => ({
        type: 'album',
        source: SOURCE,
        id: findId(item.artist.name, item.title),
        title: item.title,
        artists: [{ name: item.artist.name }],
        year: item.releaseDate?.slice(0, 4),
        thumbnail: tidalImage(item.cover, 640),
        explicit: Boolean(item.explicit),
      }),
    )
  return { sections: section('picks', "Editors' picks", albums), filters: [], selectedFilter: null, hasMore: false }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

async function tidalPlaylists(query: string): Promise<Playlist[]> {
  if (!hasKind('hifi')) return []
  const body = await call<Raw>('hifi', `/search/?p=${encodeURIComponent(query)}`)
  return (body.data?.playlists?.items ?? []).map(toTidalPlaylist)
}

/** With a hifi-api instance, search is TIDAL's (as in Monochrome); Deezer's results join with a Deezer instance. */
async function hifiSearch(query: string, type: string): Promise<SearchResult> {
  if (type === 'playlist') return { sections: [], items: await tidalPlaylists(query), hasMore: false }
  if (type !== 'all') return { sections: [], items: await tidalSearch(query, type), hasMore: false }
  const [all, playlists, deezer] = await Promise.all([tidalSearchAll(query), settled(tidalPlaylists(query)), hasKind('deezer') ? settled(deezerSearch(query)) : null])
  return {
    sections: [
      ...section('songs', 'Songs', all.songs, 'list'),
      ...section('albums', 'Albums', all.albums),
      ...section('artists', 'Artists', all.artists),
      ...section('deezer', 'On Deezer', deezer ?? [], 'list'),
      ...section('playlists', 'TIDAL playlists', playlists ?? []),
    ],
    items: [],
    hasMore: false,
  }
}

async function searchQuery({ query, type }: { query: string; type: string }): Promise<SearchResult> {
  if (type === 'deezer') return { sections: [], items: await deezerSearch(query), hasMore: false }
  if (hasKind('hifi')) return hifiSearch(query, type)
  const q = encodeURIComponent(query)
  if (type === 'song') return { sections: [], items: ((await call<Raw>('tracks', `/search/tracks?q=${q}&limit=50`)).tracks ?? []).map((track: Raw) => toSong(track)), hasMore: false }
  if (type === 'album') return { sections: [], items: ((await call<Raw>('tracks', `/search/releases?q=${q}&limit=50`)).releases ?? []).map(toAlbum), hasMore: false }
  if (type === 'artist') return { sections: [], items: ((await call<Raw>('tracks', `/search/artists?q=${q}&limit=50`)).artists ?? []).map(toArtist), hasMore: false }
  if (type === 'playlist') return { sections: [], items: await tidalPlaylists(query), hasMore: false }

  const [body, playlists, deezer] = await Promise.all([call<Raw>('tracks', `/search?q=${q}`), settled(tidalPlaylists(query)), hasKind('deezer') ? settled(deezerSearch(query)) : null])
  const top = (body.topResults ?? [])
    .map((item: Raw) => (item.entityType === 'artist' ? toArtist(item) : item.entityType === 'release' || item.releaseType ? toAlbum(item) : item.trackId ? toSong(item) : null))
    .filter(Boolean) as Item[]
  return {
    sections: [
      ...section('top', 'Top result', top.slice(0, 1), 'list'),
      ...section('songs', 'Songs', (body.tracks ?? []).map((track: Raw) => toSong(track)), 'list'),
      ...section('albums', 'Albums', (body.releases ?? []).map(toAlbum)),
      ...section('artists', 'Artists', (body.artists ?? []).map(toArtist)),
      ...section('deezer', 'On Deezer', deezer ?? [], 'list'),
      ...section('playlists', 'TIDAL playlists', playlists ?? []),
    ],
    items: [],
    hasMore: false,
  }
}

/* ------------------------------------------------------------------ *
 * Albums (releases, and editors' picks found by name) and TIDAL playlists
 * ------------------------------------------------------------------ */

const normalize = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

async function findRelease(id: string): Promise<string> {
  const [artist, title] = rest(id, 'find').split(':').map(decodeURIComponent)
  const releases: Raw[] = (await call<Raw>('tracks', `/search/releases?q=${encodeURIComponent(`${artist} ${title}`)}&limit=10`)).releases ?? []
  const named = (release: Raw) => normalize(release.title) === normalize(title)
  const byArtist = (release: Raw) => artistsOf(release).some((ref) => normalize(ref.name) === normalize(artist))
  const best = releases.find((release) => named(release) && byArtist(release)) ?? releases.find(named)
  if (!best) throw new InstanceError(`"${title}" by ${artist} isn't in the Monochrome catalog`, 404)
  return String(best.releaseId ?? best.id)
}

/**
 * An editors' pick the catalog doesn't have, from TIDAL through a hifi-api instance
 * (searched again: the picks list keeps TIDAL ids that go stale). Its songs play from
 * the catalog if it has them one by one, else from another service ("Play from").
 */
async function pickFromTidal(id: string): Promise<CollectionPage> {
  const [artist, title] = rest(id, 'find').split(':').map(decodeURIComponent)
  const found: Raw[] = (await call<Raw>('hifi', `/search/?al=${encodeURIComponent(`${artist} ${title}`)}`)).data?.albums?.items ?? []
  const album = found.find((item) => normalize(item.title) === normalize(title) && (item.artists ?? [item.artist]).some((ref: Raw) => normalize(ref?.name ?? '') === normalize(artist)))
  if (!album) throw new InstanceError(`"${title}" by ${artist} isn't in the Monochrome catalog or on TIDAL`)
  const body = await call<Raw>('hifi', `/album/?id=${album.id}`)
  const data = body.data ?? {}
  return {
    id,
    kind: 'album',
    title: data.title ?? title,
    subtitle: ['TIDAL', data.releaseDate?.slice(0, 4), data.numberOfTracks ? `${data.numberOfTracks} songs` : ''].filter(Boolean).join(' · '),
    thumbnail: tidalImage(data.cover, 640),
    artists: [{ name: artist }],
    year: data.releaseDate?.slice(0, 4),
    songs: (data.items ?? []).map((entry: Raw) => entry.item ?? entry).filter((item: Raw) => item?.id).map((item: Raw) => toTidalSong({ ...item, album: { cover: data.cover } })),
    hasMore: false,
    sections: [],
  }
}

async function getAlbum({ id }: { id: string }): Promise<CollectionPage> {
  if (id.startsWith(`${SOURCE}:tidal-album:`)) return tidalAlbumPage(id)
  // Editors' picks are TIDAL albums: on TIDAL first when there's a hifi-api instance.
  if (id.startsWith(`${SOURCE}:find:`) && hasKind('hifi')) {
    try {
      return await pickFromTidal(id)
    } catch (error) {
      if (!hasKind('tracks')) throw error
    }
  }
  let release: string
  try {
    release = id.startsWith(`${SOURCE}:find:`) ? await findRelease(id) : rest(id, 'release')
  } catch (error) {
    if (!(error instanceof InstanceError && error.status === 404) || !hasKind('hifi')) throw error
    return pickFromTidal(id)
  }
  const data = await call<Raw>('tracks', `/releases/${release}`)
  const album = toAlbum(data)
  return {
    id,
    kind: 'album',
    title: data.title,
    subtitle: [album.kind, album.year, data.trackCount ? `${data.trackCount} songs` : '', data.label].filter(Boolean).join(' · '),
    secondSubtitle: 'Lossless · FLAC',
    thumbnail: album.thumbnail,
    artists: album.artists,
    year: album.year,
    songs: (data.tracks ?? []).map((track: Raw) => toSong({ ...track, albumTitle: data.title }, data)),
    hasMore: false,
    sections: [],
  }
}

async function getPlaylist({ id }: { id: string }): Promise<CollectionPage> {
  const body = await call<Raw>('hifi', `/playlist/?id=${encodeURIComponent(rest(id, 'tidal-playlist'))}`)
  const playlist = body.playlist ?? {}
  return {
    id,
    kind: 'playlist',
    title: playlist.title ?? 'Playlist',
    subtitle: ['TIDAL', playlist.numberOfTracks ? `${playlist.numberOfTracks} tracks` : ''].filter(Boolean).join(' · '),
    description: playlist.description || undefined,
    thumbnail: tidalImage(playlist.squareImage ?? playlist.image, 480),
    artists: [],
    songs: (body.items ?? []).map((entry: Raw) => entry.item ?? entry).filter((item: Raw) => item?.id && item.title).map(toTidalSong),
    hasMore: false,
    sections: [],
  }
}

/* ------------------------------------------------------------------ *
 * Artists
 * ------------------------------------------------------------------ */

async function getArtist({ id }: { id: string }): Promise<ArtistPage> {
  if (id.startsWith(`${SOURCE}:tidal-artist:`)) return tidalArtist(id)
  const data = await call<Raw>('tracks', `/artists/${rest(id, 'artist')}`)
  const top = (data.topTracks ?? []).map((track: Raw) => toSong(track))
  return {
    id,
    name: data.displayName || data.name,
    description: data.biography || data.bio || undefined,
    thumbnail: data.avatar || undefined,
    shuffle: { playlistId: `artist-shuffle:${rest(id, 'artist')}` },
    radio: { playlistId: `artist-radio:${rest(id, 'artist')}` },
    sections: [
      ...section('top', 'Top songs', top, 'list'),
      ...section('albums', 'Albums', (data.albums ?? []).map(toAlbum)),
      ...section('singles', 'Singles and EPs', (data.singles ?? []).map(toAlbum)),
      ...section('compilations', 'Compilations', (data.compilations ?? []).map(toAlbum)),
    ],
  }
}

/* ------------------------------------------------------------------ *
 * Queues. The tracks API has no recommendations: a radio is the artist's top
 * songs and a few of their albums, shuffled.
 * ------------------------------------------------------------------ */

function shuffle<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function artistMix(artist: string): Promise<Song[]> {
  const data = await call<Raw>('tracks', `/artists/${artist}`)
  const releases = shuffle([...(data.albums ?? []), ...(data.singles ?? [])]).slice(0, 3)
  const albums = await Promise.all(releases.map((release: Raw) => settled(call<Raw>('tracks', `/releases/${release.releaseId ?? release.id}`))))
  const songs = [...(data.topTracks ?? []).map((track: Raw) => toSong(track)), ...albums.flatMap((album) => (album?.tracks ?? []).map((track: Raw) => toSong({ ...track, albumTitle: album!.title }, album!)))]
  const seen = new Set<string>()
  return shuffle(songs.filter((song) => !seen.has(song.id) && seen.add(song.id)))
}

const firstArtist = (song: Song) => song.artists.find((artist) => artist.id?.startsWith(`${SOURCE}:artist:`) || artist.id?.startsWith(`${SOURCE}:tidal-artist:`))?.id

const queue = {
  async start({ playlistId }: { playlistId?: string }): Promise<QueuePage> {
    const value = String(playlistId ?? '')
    if (value.startsWith('artist-shuffle:') || value.startsWith('artist-radio:')) return { songs: await artistMix(value.split(':')[1]) }
    if (value.startsWith('tidal-artist-shuffle:')) return { songs: shuffle(await tidalArtistSongs(value.split(':')[1])) }
    return { songs: [] }
  },
  async radio(seed: RadioSeed): Promise<QueuePage> {
    let first: Song | undefined
    if (seed.kind === 'song') first = seed.song
    else first = (seed.kind === 'album' ? await getAlbum({ id: seed.album.id }) : await getPlaylist({ id: seed.playlist.id })).songs[0]
    const artist = first ? firstArtist(first) : undefined
    if (!first || !artist) return { songs: first ? [first] : [] }
    const pool = artist.startsWith(`${SOURCE}:tidal-artist:`) ? shuffle(await tidalArtistSongs(rest(artist, 'tidal-artist'))) : await artistMix(rest(artist, 'artist'))
    const songs = pool.filter((song) => song.id !== first!.id)
    return { songs: [first, ...songs] }
  },
}

/* ------------------------------------------------------------------ *
 * Streams: FLAC straight from a tracks instance
 * ------------------------------------------------------------------ */

/** TIDAL track (a playlist's) → the same track on the tracks catalog. */
const found = new Map<string, string>()

async function findTrack(song: Song): Promise<string> {
  const known = found.get(song.id)
  if (known) return known
  const isrc = song.id.split(':')[3]
  const query = `${song.artists[0]?.name ?? ''} ${song.title}`.trim()
  const candidates: Raw[] = (await call<Raw>('tracks', `/search/tracks?q=${encodeURIComponent(query)}&limit=10`)).tracks ?? []
  const exact = isrc ? candidates.find((candidate) => candidate.isrc === isrc) : undefined
  const ranked = candidates.map((candidate) => ({ candidate, score: Noctis.libs.matching.matchScore(song, toSong(candidate)) })).sort((a, b) => b.score - a.score)
  const best = exact ?? (ranked[0] && ranked[0].score >= 0.7 ? ranked[0].candidate : undefined)
  if (!best) throw new StreamError(`"${song.title}" isn't on your Monochrome instances`)
  const id = String(best.trackId ?? best.id)
  found.set(song.id, id)
  return id
}

/**
 * The file's size from a one-byte range request (instances answer 206 with
 * Content-Range), for downloads and the bitrate. Through Noctis.libs.http: instances
 * don't expose Content-Range to cross-origin fetch().
 */
async function sizeOf(url: string): Promise<number | undefined> {
  try {
    const response = await http.request(url, { headers: { range: 'bytes=0-0' } })
    const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-range')?.[1] ?? ''
    const total = Number(/\/(\d+)$/.exec(header)?.[1])
    return response.status === 206 && total > 0 ? total : undefined
  } catch {
    return undefined
  }
}

async function catalogStream(id: string, song: Song): Promise<StreamInfo> {
  const list = rotation('tracks')
  for (const instance of list) {
    const url = `${instance.url}/track/${id}`
    const size = await sizeOf(url)
    if (size !== undefined) return { url, mimeType: 'audio/flac', bitrate: song.duration ? Math.round((size * 8) / song.duration) : 0, contentLength: size, expiresAt: Date.now() + 6 * 3600_000 }
  }
  // No instance answered the size check (some networks strip ranges): play from the first anyway.
  return { url: `${list[0].url}/track/${id}`, mimeType: 'audio/flac', bitrate: 0, expiresAt: Date.now() + 6 * 3600_000 }
}

/**
 * Where a song's audio comes from, by what it is: a catalog track streams from a tracks
 * instance; a TIDAL track from hifi-api's lossless manifest, else the same track on a
 * tracks instance, else a Deezer instance by ISRC (Monochrome's fallback order); a
 * Deezer track from a Deezer instance. Data saver doesn't apply to FLAC.
 */
async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  if (isDeezer(song.id)) return deezerStream(song, efficient)
  if (!isTidal(song.id)) return catalogStream(rawTrack(song.id), song)
  const attempts: (() => Promise<StreamInfo>)[] = []
  if (hasKind('hifi')) attempts.push(() => tidalStream(song))
  if (hasKind('tracks')) attempts.push(async () => catalogStream(await findTrack(song), song))
  if (hasKind('deezer') && song.id.split(':')[3]) attempts.push(() => deezerStream(song, efficient))
  let lastError: unknown = new StreamError('Add a Monochrome API instance first: Settings → Monochrome')
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

const service: ServiceDefinition = {
  name: 'Monochrome',
  icon: 'quality',
  home: { load: loadHome },
  search: {
    get filters() {
      return [
        { id: 'song', label: 'Songs' },
        { id: 'album', label: 'Albums' },
        { id: 'artist', label: 'Artists' },
        ...(hasKind('hifi') ? [{ id: 'playlist', label: 'TIDAL playlists' }] : []),
        ...(hasKind('deezer') ? [{ id: 'deezer', label: 'Deezer' }] : []),
      ]
    },
    query: searchQuery,
  },
  albums: { get: getAlbum },
  playlists: { get: getPlaylist },
  artists: { get: getArtist },
  queue,
  streams: { resolve: resolveStream },
  links: {
    share(item) {
      if (item.type === 'song' && !item.id.startsWith(`${SOURCE}:tidal:`)) return `https://monochrome.st/track/${rawTrack(item.id)}`
      if (item.type === 'album' && item.id.startsWith(`${SOURCE}:release:`)) return `https://monochrome.st/album/${rest(item.id, 'release')}`
      if (item.type === 'artist') return `https://monochrome.st/artist/${rest(item.id, 'artist')}`
      return undefined
    },
  },
}

/* ------------------------------------------------------------------ *
 * Settings → Monochrome: API instances
 * ------------------------------------------------------------------ */

const KIND_LABEL: Record<Instance['kind'], string> = {
  hifi: 'hifi-api (TIDAL): search, albums, lossless streams',
  tracks: 'Tracks API: catalog and FLAC streams',
  deezer: 'Deezer: FLAC by ISRC, and Deezer search',
}

function promptInstance() {
  showTextDialog({
    title: 'Add an API instance',
    description: 'A hifi-api instance (like api.monochrome.tf), a tracks API (like tracks.monochrome.st) or a Deezer instance. Its kind is detected when it’s added.',
    placeholder: 'https://…',
    confirmLabel: 'Add',
    async onConfirm(value) {
      try {
        const instance = await addInstance(value)
        notify(`Added ${new URL(instance.url).host} (${instance.kind === 'tracks' ? 'catalog and streams' : 'TIDAL playlists'})`)
      } catch (error) {
        notify((error as Error).message)
      }
    },
  })
}

/** Monochrome's INSTANCES.md (and its Deezer default), one tap each; added ones disappear. */
const suggestedRows = SUGGESTED.map((suggestion) => ({
  id: `suggest:${suggestion.url}`,
  icon: 'add-link',
  title: new URL(suggestion.url).host,
  description: KIND_LABEL[suggestion.kind],
  get hidden() {
    return instances.value.some((instance) => instance.url === suggestion.url)
  },
  async onClick() {
    try {
      await addInstance(suggestion.url, suggestion.kind)
      notify(`Added ${new URL(suggestion.url).host}`)
    } catch (error) {
      notify((error as Error).message)
    }
  },
}))

function defineSettings(Plugin: PluginScope['Plugin']) {
  const rows = shallowReactive<Raw[]>([])
  const stop = watch(
    instances,
    (list) => {
      rows.splice(
        0,
        rows.length,
        ...list.map((instance) => ({
          id: instance.url,
          icon: instance.kind === 'tracks' ? 'server' : 'playlist',
          title: new URL(instance.url).host,
          description: `${KIND_LABEL[instance.kind]}${instance.version ? ` · ${instance.version}` : ''}`,
          onClick() {
            confirm({
              title: `Remove ${new URL(instance.url).host}?`,
              message: 'Noctis stops using this instance. You can add it again later.',
              confirmLabel: 'Remove',
              destructive: true,
              onConfirm: () => removeInstance(instance.url),
            })
          },
        })),
      )
    },
    { immediate: true },
  )

  Plugin.defineSection(
    {
      id: SOURCE,
      icon: 'quality',
      title: 'Monochrome',
      get description() {
        const count = instances.value.length
        return count === 0 ? 'Add an API instance to start' : `${count} API ${count === 1 ? 'instance' : 'instances'}`
      },
    },
    [
      {
        id: 'intro',
        type: 'note',
        text: 'Monochrome plays lossless music through API instances people run, as monochrome.st does. Add at least one: a hifi-api instance (TIDAL) for search and streams, a tracks API, and optionally Deezer for songs TIDAL lacks. Requests go to a random one and move on when one is down or busy.',
      },
      { id: 'instances-header', type: 'header', title: 'API instances', get hidden() { return instances.value.length === 0 } },
      Noctis.group('instances', rows as never),
      Noctis.group('add', [
        { id: 'add', icon: 'add-link', title: 'Add an instance', description: 'hifi-api, a tracks API or a Deezer instance', onClick: promptInstance },
      ]),
      { id: 'suggested-header', type: 'header', title: 'From Monochrome’s instance list', get hidden() { return suggestedRows.every((row) => row.hidden) } },
      Noctis.group('suggested', suggestedRows as never),
      {
        id: 'note',
        type: 'note',
        text: 'Songs stream as FLAC (lossless), so they use more data than other services; data saver doesn\'t apply. A hifi-api instance adds TIDAL playlists; their songs play from your catalog instances when those have them. Instances are run by the community, not by Noctis.',
      },
    ],
  )
  return stop
}

export default function monochrome({ Plugin }: PluginScope) {
  initInstances(Plugin.storage as never)
  let stopRows: (() => void) | null = null
  let stopMatching: (() => void) | null = null
  const hasCatalog = computed(() => instances.value.length > 0)

  const attach = () => {
    Plugin.defineService(SOURCE, service)
    stopRows = defineSettings(Plugin)
    // Lossless copies of songs from elsewhere, once there's a catalog to search.
    stopMatching ??= Noctis.libs.matching.offerAsSource(SOURCE, { minScore: 0.75 })
    if (!hasCatalog.value) Plugin.log('No API instance yet: add one in Settings → Monochrome')
  }

  const detach = () => {
    stopMatching?.()
    stopMatching = null
    stopRows?.()
    stopRows = null
    Plugin.removeService(SOURCE)
    Plugin.removeSection(SOURCE)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
