import { shallowRef, watch } from 'vue'
import type { Album, Artist, ArtistRef, CollectionPage, Item, Playlist, Section, Song, StreamInfo } from '../models'
import { chosenOption, playbackMode, registerPlaybackOptions, registerPlaybackTargets, type PlaybackOption, type PlaybackTarget } from '../playFrom'
import { queue } from '../player'
import { hookRegistry } from '../plugins/hooks'
import { writeLog } from '../plugins/log'
import { findPlugin } from '../plugins/store'
import { audioQuality } from '../preferences'
import { request as serviceRequest } from '../services/api'
import { StreamError } from '../services/stream'
import { defineService, removeService, services } from '../services/registry'
import type { ServiceDefinition } from '../services/types'
import { handshake, serverKind, serverRequest, serverStatus, serverUrl } from '../server'
import { serverAccount } from './account'
import { canUseServer, coverUrl, credentials, restUrl, streamUrl, subsonic, type SubsonicPayload } from './client'

/**
 * The connected server as a Noctis service: home, search, albums, artists, playlists,
 * likes, radio and streams over OpenSubsonic. Works with any OpenSubsonic server; with
 * a Noctis server it also uses /api/noctis/v1 for recommendations and for choosing where
 * each song plays from.
 *
 * Where a song plays from (src/playFrom.ts): the server lists every source of a song;
 * with the "auto" or "own" preference a source one of your own services can play is
 * played there (the server doesn't spend bandwidth), otherwise the server streams it.
 * Each source is also an option in the player's "Play from" menu.
 */

export const SERVICE_ID = 'noctis-server'

/* ---------------- OpenSubsonic → Noctis models ---------------- */

const artistsOf = (child: SubsonicPayload): ArtistRef[] =>
  Array.isArray(child.artists) && child.artists.length > 0
    ? child.artists.map((artist: { id?: string; name: string }) => ({ id: artist.id, name: artist.name }))
    : [{ id: child.artistId, name: child.artist ?? child.displayArtist ?? 'Unknown artist' }]

export function toSong(child: SubsonicPayload): Song {
  return {
    type: 'song',
    source: SERVICE_ID,
    id: child.id,
    title: child.title ?? child.name ?? 'Unknown title',
    artists: artistsOf(child),
    album: child.albumId ? { id: child.albumId, name: child.album ?? '' } : undefined,
    duration: child.duration,
    thumbnail: coverUrl(child.coverArt),
  }
}

function toAlbum(album: SubsonicPayload): Album {
  return {
    type: 'album',
    source: SERVICE_ID,
    id: album.id,
    title: album.name ?? album.title ?? album.album,
    artists: artistsOf(album),
    year: album.year ? String(album.year) : undefined,
    thumbnail: coverUrl(album.coverArt),
  }
}

function toArtist(artist: SubsonicPayload): Artist {
  return {
    type: 'artist',
    source: SERVICE_ID,
    id: artist.id,
    name: artist.name,
    subtitle: artist.albumCount !== undefined ? `${artist.albumCount} ${artist.albumCount === 1 ? 'album' : 'albums'}` : undefined,
    thumbnail: coverUrl(artist.coverArt),
  }
}

function toPlaylist(playlist: SubsonicPayload): Playlist {
  return {
    type: 'playlist',
    source: SERVICE_ID,
    id: playlist.id,
    title: playlist.name,
    subtitle: `${playlist.songCount ?? 0} songs${playlist.owner ? ` · ${playlist.owner}` : ''}`,
    thumbnail: coverUrl(playlist.coverArt),
  }
}

const list = <T>(value: T[] | undefined) => value ?? []
const section = (id: string, title: string, items: Item[], layout: Section['layout'] = 'carousel', strapline?: string): Section[] =>
  items.length > 0 ? [{ id, title, items, layout, strapline }] : []

/* ---------------- Noctis server extras ---------------- */

async function recommendations(seed: string | undefined, limit: number, context: string): Promise<Song[]> {
  if (serverKind.value !== 'noctis') return []
  const params = new URLSearchParams({ limit: String(limit), context })
  if (seed) params.set('seed', seed)
  try {
    const body = await serverRequest<{ songs: SubsonicPayload[] }>(`/api/noctis/v1/recommendations?${params}`)
    return body.songs.map(toSong)
  } catch (error) {
    writeLog('noctis', 'warn', "Couldn't load recommendations:", error)
    return []
  }
}

/** One source of a song, as /api/noctis/v1/songs/:id/sources lists it. */
interface ServerSource {
  key: string
  provider: string
  name: string
  externalId: string
  /** A /rest/stream path for exactly this source, or null if the server can't stream it. */
  stream: string | null
  clientService: string | null
  clientPlugin: string | null
  install: string | null
  contentType: string | null
  suffix: string | null
  bitRate: number | null
  size: number | null
  lossless: boolean
}

interface SongSources {
  stream: string | null
  sources: ServerSource[]
}

/* ---------------- Sources, fetched in batches ---------------- */

const SOURCES_TTL = 10 * 60_000
const sourceCache = new Map<string, { at: number; value: SongSources }>()

/** Sources of many songs at once (one request), into the cache. */
async function prefetchSources(ids: string[]) {
  const missing = [...new Set(ids)].filter((id) => (sourceCache.get(id)?.at ?? 0) <= Date.now() - SOURCES_TTL).slice(0, 200)
  if (missing.length === 0 || serverKind.value !== 'noctis' || !canUseServer()) return
  try {
    const body = await serverRequest<{ songs: Record<string, SongSources> }>('/api/noctis/v1/sources', { method: 'POST', body: { ids: missing } })
    for (const [id, value] of Object.entries(body.songs)) sourceCache.set(id, { at: Date.now(), value })
  } catch (error) {
    writeLog('noctis', 'warn', "Couldn't prefetch song sources:", error)
  }
}

async function sourcesOf(song: Song): Promise<SongSources | null> {
  if (serverKind.value !== 'noctis') return null
  const cached = sourceCache.get(song.id)
  if (cached && cached.at > Date.now() - SOURCES_TTL) return cached.value
  try {
    const value = await serverRequest<SongSources>(`/api/noctis/v1/songs/${encodeURIComponent(song.id)}/sources`)
    sourceCache.set(song.id, { at: Date.now(), value })
    return value
  } catch (error) {
    writeLog('noctis', 'warn', `Couldn't read the sources of "${song.title}":`, error)
    return null
  }
}

const quality = (source: ServerSource) =>
  [source.lossless ? 'Lossless' : '', source.suffix?.toUpperCase(), source.bitRate ? `${source.bitRate} kbps` : ''].filter(Boolean).join(' · ')

/** A stream of exactly one server source. */
async function serverStream(song: Song, path: string, efficient: boolean, source?: ServerSource): Promise<StreamInfo> {
  const maxBitRate = efficient || audioQuality.value === 'low' ? 128 : undefined
  const url = new URL(`${serverUrl.value}${path}`)
  const auth = new URL(streamUrl(song.id, maxBitRate))
  for (const [key, value] of auth.searchParams) if (!url.searchParams.has(key)) url.searchParams.set(key, value)
  let contentType = source?.contentType
  let bitRate = source?.bitRate
  let size = source?.size
  if (!source) {
    const child = (await subsonic('getSong', { id: song.id })).song as SubsonicPayload
    contentType = child.contentType
    bitRate = child.bitRate
    size = child.size
  }
  return {
    url: url.href,
    mimeType: contentType ?? 'audio/mpeg',
    bitrate: (bitRate ?? 0) * 1000,
    // A transcoded stream (maxBitRate) has a different size than the file.
    contentLength: maxBitRate ? undefined : (size ?? undefined),
    expiresAt: Date.now() + 365 * 24 * 3600_000,
    fetchUrl: url.href,
  }
}

const ownSong = (song: Song, source: ServerSource): Song => ({ ...song, id: source.externalId, source: source.clientService ?? undefined })

/** The server's sources as "Play from" options: each server stream, and your own services. */
async function serverOptions(song: Song): Promise<PlaybackOption[]> {
  if (song.source !== SERVICE_ID) return []
  const info = await sourcesOf(song)
  if (!info) return []
  const options: PlaybackOption[] = []
  // Known only from an indexer (MusicBrainz): the server has nothing to stream.
  if (!info.stream) {
    options.push({
      id: 'default',
      label: `${services[SERVICE_ID]?.name ?? 'Server'} · Its best source`,
      description: `No audio on the server; it knows this song from ${info.sources.map((source) => source.name).join(', ') || 'its catalog'}`,
      available: false,
      group: 'server',
      resolve: () => Promise.reject(new StreamError('The server has no audio for this song')),
    })
  }
  for (const source of info.sources) {
    if (source.stream) {
      const path = source.stream
      options.push({
        id: `server:${source.key}`,
        label: `${services[SERVICE_ID]?.name ?? 'Server'} · ${source.name}`,
        description: quality(source) || 'Streamed by the server',
        available: true,
        target: `server:${source.provider}`,
        group: 'server',
        resolve: (efficient) => serverStream(song, path, efficient, source),
      })
    }
    const own = source.clientService
    if (own && own !== SERVICE_ID) {
      const installed = Boolean(services[own]?.streams)
      const plugin = source.clientPlugin
      options.push({
        id: `own:${own}:${source.externalId}`,
        label: services[own]?.name ?? source.name,
        description: installed
          ? 'With your own account'
          : plugin && !findPlugin(plugin)
            ? `Needs the "${plugin}" plugin${source.install ? ' (the server has it)' : ''}`
            : `Turn on ${source.name} to play from it`,
        available: installed,
        target: `own:${own}`,
        group: 'own',
        install: !installed && plugin ? { plugin, download: source.install } : undefined,
        resolve: (efficient) => serviceRequest(own, 'streams.resolve', { song: ownSong(song, source), efficient }),
      })
    }
  }
  return options
}

/** A provider of the server's catalog (GET /api/noctis/v1/providers). */
interface ServerProvider {
  id: string
  name: string
  /** The server can stream its sources (absent from older servers: assume it can). */
  streams?: boolean
  clientService?: string | null
  clientPlugin?: string | null
}

const serverProviders = shallowRef<ServerProvider[]>([])

async function loadProviders() {
  // Until the required plugins are in, the server answers 428; connect() attaches again after.
  if (serverKind.value !== 'noctis' || serverStatus.value !== 'connected') return
  try {
    serverProviders.value = await serverRequest<ServerProvider[]>('/api/noctis/v1/providers')
  } catch (error) {
    writeLog('noctis', 'warn', "Couldn't list the server's providers:", error)
  }
}

/**
 * Targets for the preference: each of the server's providers, and the services that
 * would play their songs with your own account (greyed out until their plugin runs).
 */
function serverTargets(): PlaybackTarget[] {
  const server = services[SERVICE_ID]?.name ?? 'Server'
  const offered = new Set(handshake.value?.plugins.map((plugin) => plugin.id))
  return serverProviders.value.flatMap((provider): PlaybackTarget[] => {
    const targets: PlaybackTarget[] =
      provider.streams === false ? [] : [{ id: `server:${provider.id}`, label: `${server} · ${provider.name}`, group: 'server', available: true, description: 'Streamed by the server' }]
    const own = provider.clientService
    if (own && own !== SERVICE_ID && !services[own]?.streams) {
      const plugin = provider.clientPlugin
      targets.push({
        id: `own:${own}`,
        label: provider.name,
        group: 'own',
        available: false,
        description: plugin && !findPlugin(plugin) ? `Needs the "${plugin}" plugin${offered.has(plugin) ? ' (the server has it)' : ''}` : `Turn on ${provider.name} to play from it`,
      })
    }
    return targets
  })
}

/** Play a source with one of this client's own services, if it has the right one. */
async function playWithOwnService(song: Song, sources: ServerSource[], efficient: boolean): Promise<StreamInfo | null> {
  for (const source of sources) {
    const service = source.clientService
    if (!service || service === SERVICE_ID || !services[service]?.streams) continue
    try {
      const info = await serviceRequest(service, 'streams.resolve', { song: ownSong(song, source), efficient })
      writeLog('noctis', 'info', `Playing "${song.title}" from ${services[service]?.name ?? service} instead of the server`)
      return info
    } catch (error) {
      writeLog('noctis', 'warn', `${service} couldn't play "${song.title}":`, error)
    }
  }
  return null
}

/* ---------------- The service ---------------- */

const service: ServiceDefinition = {
  get name() {
    return handshake.value?.server.name ?? 'Server'
  },
  icon: 'server',

  home: {
    async load() {
      const [forYou, recent, newest, random, starred] = await Promise.all([
        recommendations(undefined, 16, 'home'),
        subsonic('getAlbumList2', { type: 'recent', size: 16 }).catch(() => null),
        subsonic('getAlbumList2', { type: 'newest', size: 16 }),
        subsonic('getAlbumList2', { type: 'random', size: 16 }),
        subsonic('getAlbumList2', { type: 'starred', size: 16 }).catch(() => null),
      ])
      const albums = (body: SubsonicPayload | null) => list<SubsonicPayload>(body?.albumList2?.album).map(toAlbum)
      return {
        sections: [
          ...section('for-you', 'For you', forYou, 'quick-picks'),
          ...section('recent', 'Recently played', albums(recent)),
          ...section('starred', 'Starred', albums(starred)),
          ...section('newest', 'Recently added', albums(newest)),
          ...section('random', 'Discover', albums(random)),
        ],
        filters: [],
        selectedFilter: null,
        hasMore: false,
      }
    },
  },

  search: {
    filters: [
      { id: 'songs', label: 'Songs' },
      { id: 'albums', label: 'Albums' },
      { id: 'artists', label: 'Artists' },
    ],
    async query({ query, type }) {
      const counts = type === 'all' ? { songCount: 20, albumCount: 12, artistCount: 12 } : { songCount: type === 'songs' ? 100 : 0, albumCount: type === 'albums' ? 100 : 0, artistCount: type === 'artists' ? 100 : 0 }
      const body = await subsonic('search3', { query, ...counts })
      const songs = list<SubsonicPayload>(body.searchResult3?.song).map(toSong)
      const albums = list<SubsonicPayload>(body.searchResult3?.album).map(toAlbum)
      const artists = list<SubsonicPayload>(body.searchResult3?.artist).map(toArtist)
      if (type !== 'all') return { sections: [], items: type === 'songs' ? songs : type === 'albums' ? albums : artists, hasMore: false }
      return {
        sections: [...section('songs', 'Songs', songs, 'list'), ...section('albums', 'Albums', albums), ...section('artists', 'Artists', artists)],
        items: [],
        hasMore: false,
      }
    },
  },

  albums: {
    async get({ id }): Promise<CollectionPage> {
      const album = (await subsonic('getAlbum', { id })).album
      const songs = list<SubsonicPayload>(album.song).map(toSong)
      return {
        id,
        kind: 'album',
        title: album.name,
        subtitle: [album.year, `${songs.length} songs`].filter(Boolean).join(' · '),
        thumbnail: coverUrl(album.coverArt),
        artists: artistsOf(album),
        year: album.year ? String(album.year) : undefined,
        songs,
        hasMore: false,
        sections: [],
      }
    },
  },

  playlists: {
    async get({ id }): Promise<CollectionPage> {
      const playlist = (await subsonic('getPlaylist', { id })).playlist
      return {
        id,
        kind: 'playlist',
        title: playlist.name,
        subtitle: `${playlist.songCount ?? 0} songs${playlist.owner ? ` · ${playlist.owner}` : ''}`,
        description: playlist.comment,
        thumbnail: coverUrl(playlist.coverArt),
        artists: [],
        songs: list<SubsonicPayload>(playlist.entry).map(toSong),
        hasMore: false,
        sections: [],
      }
    },
  },

  artists: {
    async get({ id }) {
      const artist = (await subsonic('getArtist', { id })).artist
      const top = await subsonic('getTopSongs', { artist: artist.name, count: 10 }).catch(() => null)
      return {
        id,
        name: artist.name,
        thumbnail: coverUrl(artist.coverArt),
        sections: [
          ...section('top', 'Top songs', list<SubsonicPayload>(top?.topSongs?.song).map(toSong), 'list'),
          ...section('albums', 'Albums', list<SubsonicPayload>(artist.album).map(toAlbum)),
        ],
      }
    },
  },

  queue: {
    async radio(seed) {
      const id = seed.kind === 'song' ? seed.song.id : seed.kind === 'album' ? seed.album.id : seed.playlist.id
      let songs = await recommendations(seed.kind === 'song' ? id : undefined, 50, 'radio')
      if (songs.length === 0) {
        const similar = await subsonic('getSimilarSongs2', { id, count: 50 }).catch(() => null)
        songs = list<SubsonicPayload>(similar?.similarSongs2?.song).map(toSong)
      }
      if (songs.length === 0) songs = list<SubsonicPayload>((await subsonic('getRandomSongs', { size: 50 })).randomSongs?.song).map(toSong)
      return { songs: seed.kind === 'song' ? [seed.song, ...songs.filter((song) => song.id !== id)] : songs }
    },
  },

  library: {
    async playlists() {
      return list<SubsonicPayload>((await subsonic('getPlaylists')).playlists?.playlist).map(toPlaylist)
    },
    async artists() {
      const body = await subsonic('getArtists')
      return list<SubsonicPayload>(body.artists?.index).flatMap((index) => list<SubsonicPayload>(index.artist).map(toArtist))
    },
    async liked() {
      return { songs: list<SubsonicPayload>((await subsonic('getStarred2')).starred2?.song).map(toSong), hasMore: false }
    },
    async like({ song, liked }) {
      await subsonic(liked ? 'star' : 'unstar', { id: song.id })
    },
  },

  streams: {
    async resolve({ song, efficient }): Promise<StreamInfo> {
      // "Its best source", chosen for this song, means the server's stream.
      const info = await sourcesOf(song)
      if (playbackMode.value !== 'server' && chosenOption(song) !== 'default') {
        const own = info ? await playWithOwnService(song, info.sources, efficient) : null
        if (own) return own
      }
      // Songs only an indexer knows (MusicBrainz) have no audio here: say so, and the
      // player tries the song's other options (src/services/stream.ts).
      if (info && !info.stream) throw new StreamError(`${services[SERVICE_ID]?.name ?? 'The server'} has no audio for this song`)
      return serverStream(song, `/rest/stream?id=${encodeURIComponent(song.id)}`, efficient)
    },
  },

  links: {
    share: () => undefined,
  },

  thumbnails: {
    resize(url, size) {
      if (!serverUrl.value || !url.startsWith(`${serverUrl.value}/rest/getCoverArt`)) return undefined
      const resized = new URL(url)
      resized.searchParams.set('size', String(Math.round(size)))
      return resized.href
    },
  },

  account: serverAccount,
}

/* ---------------- Scrobbling ---------------- */

/** Count plays of the server's songs: "now playing" on start, a submission once it plays. */
function scrobble({ song }: { song?: Song }) {
  if (!song || song.source !== SERVICE_ID || !credentials.value) return
  void subsonic('scrobble', { id: song.id, submission: 'true', time: Date.now() }).catch(() => {})
}

let attached = false
let unregisterOptions: (() => void) | null = null
let unregisterTargets: (() => void) | null = null
let stopPrefetch: (() => void) | null = null

/** Show the server as a service (after signing in, or as a guest where the server allows it). */
export function attachServerService() {
  defineService(SERVICE_ID, service)
  // Again on every connect: the server's providers may have changed (or failed to load before plugins were installed).
  void loadProviders()
  if (attached) return
  attached = true
  hookRegistry.points.onPlay.after.push(scrobble)
  unregisterOptions = registerPlaybackOptions(serverOptions)
  unregisterTargets = registerPlaybackTargets(serverTargets)
  // The sources of the server's songs in the queue, in one request, before they play.
  stopPrefetch = watch(queue, (songs) => void prefetchSources(songs.filter((song) => song.source === SERVICE_ID).map((song) => song.id)), { immediate: true })
}

export function detachServerService() {
  removeService(SERVICE_ID)
  const index = hookRegistry.points.onPlay.after.indexOf(scrobble)
  if (index !== -1) hookRegistry.points.onPlay.after.splice(index, 1)
  unregisterOptions?.()
  unregisterTargets?.()
  stopPrefetch?.()
  unregisterOptions = unregisterTargets = stopPrefetch = null
  serverProviders.value = []
  sourceCache.clear()
  attached = false
}

/** Exposed for tests and plugins: the URL builder. */
export { restUrl }
