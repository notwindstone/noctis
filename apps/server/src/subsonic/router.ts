import { AuthError, can, type User } from '../auth'
import type { AlbumListType, SongRow } from '../catalog/catalog'
import { MediaError } from '../catalog/media'
import { writeLog } from '../log'
import type { Services } from '../services'
import { envelope, ERRORS, render, SubsonicError, type Payload } from './format'
import { albumToChild, albumToID3, artistToID3, indexArtists, playlistToSubsonic, songToChild } from './mappers'

/**
 * The OpenSubsonic API, at /rest/<endpoint> (with or without ".view").
 *
 * Only OpenSubsonic clients are supported, and only API keys
 * (apiKeyAuthentication): a session token from /api/noctis/v1/auth/login. Legacy Subsonic
 * auth (a password in the URL as `p`, or `t` + `s` tokens built from it) is refused
 * with error 42, and JSONP isn't offered. With guest access on, requests without a key
 * act as the "guests" group.
 *
 * Every endpoint needs a permission (see src/auth.ts); per-user ones (stars, playlists,
 * queues, bookmarks) also need an account.
 *
 * Plugins:
 * - the `onSubsonic` hook sees and may answer or change every call;
 * - `Plugin.subsonic.endpoint(name, handler)` adds an endpoint, and
 *   `Plugin.subsonic.extension(name, versions)` lists it in getOpenSubsonicExtensions.
 */

export type Params = Map<string, string[]>

export interface SubsonicContext {
  endpoint: string
  params: Params
  /** First value of a parameter. */
  param(name: string): string | undefined
  /** Every value of a repeatable parameter (id, songIdToAdd…). */
  all(name: string): string[]
  user: User
  /** Whether the caller has a permission. */
  can(permission: string): boolean
  request: Request
}

export type SubsonicHandler = (context: SubsonicContext) => Payload | Response | Promise<Payload | Response>

/** Endpoints and extensions added by plugins. */
export class SubsonicRegistry {
  readonly endpoints = new Map<string, { handler: SubsonicHandler; owner: string }>()
  readonly extensions = new Map<string, { versions: number[]; owner: string }>()

  endpoint(name: string, handler: SubsonicHandler, owner: string) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) throw new Error(`Invalid OpenSubsonic endpoint name "${name}"`)
    if (BUILT_IN.has(name)) throw new Error(`"${name}" is a built-in endpoint; change it with the onSubsonic hook instead`)
    const existing = this.endpoints.get(name)
    if (existing && existing.owner !== owner) throw new Error(`"${name}" is already provided by ${existing.owner}`)
    this.endpoints.set(name, { handler, owner })
  }

  extension(name: string, versions: number[], owner: string) {
    this.extensions.set(name, { versions, owner })
  }

  removeOwnedBy(owner: string) {
    for (const [name, entry] of this.endpoints) if (entry.owner === owner) this.endpoints.delete(name)
    for (const [name, entry] of this.extensions) if (entry.owner === owner) this.extensions.delete(name)
  }
}

/** Extensions this server implements itself. */
const OWN_EXTENSIONS = [
  { name: 'apiKeyAuthentication', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'indexBasedQueue', versions: [1] },
  // Noctis: /api/noctis/v1 (sources, recommendations, plugin negotiation).
  { name: 'noctis', versions: [1] },
]

/** What each built-in endpoint needs: a permission, and whether it's per-user. */
const NEEDS: Record<string, { permission: string | null; account?: boolean }> = {}
const need = (permission: string | null, names: string[], account = false) => {
  for (const name of names) NEEDS[name] = { permission, account }
}
need(null, ['ping', 'getLicense', 'getOpenSubsonicExtensions', 'getUser'])
need('library.read', [
  'getMusicFolders', 'getScanStatus', 'getArtists', 'getIndexes', 'getArtist', 'getAlbum', 'getSong', 'getMusicDirectory', 'getGenres',
  'getArtistInfo', 'getArtistInfo2', 'getAlbumInfo', 'getAlbumInfo2', 'getTopSongs', 'getSimilarSongs2', 'getAlbumList', 'getAlbumList2',
  'getRandomSongs', 'getSongsByGenre', 'getNowPlaying', 'search2', 'search3', 'getPlaylists', 'getPlaylist', 'getCoverArt',
])
need('library.read', ['getStarred', 'getStarred2'], true)
need('library.scan', ['startScan'])
need('stream', ['stream'])
need('download', ['download'])
need('annotate', ['star', 'unstar', 'setRating', 'scrobble'], true)
need('playlists', ['createPlaylist', 'updatePlaylist', 'deletePlaylist'], true)
need('queue', ['getPlayQueue', 'savePlayQueue', 'getPlayQueueByIndex', 'savePlayQueueByIndex', 'getBookmarks', 'createBookmark', 'deleteBookmark'], true)

const int = (value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : fallback
}

function required(context: SubsonicContext, name: string): string {
  const value = context.param(name)
  if (value === undefined || value === '') throw new SubsonicError(ERRORS.missingParameter, `Required parameter "${name}" is missing`)
  return value
}

const notFound = (what: string) => new SubsonicError(ERRORS.notFound, `${what} not found`)
const iso = (ms: number) => new Date(ms).toISOString()

function endpoints(services: Services): Record<string, SubsonicHandler> {
  const { catalog, media, recommender, scanners, registry } = { ...services, registry: services?.subsonic }
  const uid = (context: SubsonicContext) => context.user.id

  /** Songs for a queue or bookmarks response, in order, skipping ones that left the catalog. */
  const children = async (ids: string[], user: number) => (await catalog.songs(ids, user)).map(songToChild)

  return {
    /* ---------------- System ---------------- */
    ping: () => ({}),
    getLicense: () => ({ license: { valid: true } }),
    getOpenSubsonicExtensions: () => ({
      openSubsonicExtensions: [...OWN_EXTENSIONS, ...[...registry.extensions.entries()].map(([name, { versions }]) => ({ name, versions }))],
    }),
    getMusicFolders: () => ({ musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } }),
    getScanStatus: () => ({ scanStatus: scanners.status() }),
    startScan: () => {
      void scanners.scanAll()
      return { scanStatus: { ...scanners.status(), scanning: true } }
    },
    getUser: (context) => {
      const name = context.param('username') ?? context.user.name
      if (name.toLowerCase() !== context.user.name.toLowerCase() && !context.can('users.manage')) throw new SubsonicError(ERRORS.notAuthorized, 'Not allowed')
      const user = context.user
      return {
        user: {
          username: name,
          scrobblingEnabled: can(user, 'annotate'),
          adminRole: can(user, '*'),
          settingsRole: !user.guest,
          downloadRole: can(user, 'download'),
          uploadRole: false,
          playlistRole: can(user, 'playlists'),
          coverArtRole: false,
          commentRole: false,
          podcastRole: false,
          streamRole: can(user, 'stream'),
          jukeboxRole: false,
          shareRole: false,
          videoConversionRole: false,
          folder: [1],
        },
      }
    },

    /* ---------------- Browsing ---------------- */
    getArtists: async (context) => ({ artists: indexArtists(await catalog.artists(uid(context))) }),
    getIndexes: async (context) => ({ indexes: { lastModified: Date.now(), ...indexArtists(await catalog.artists(uid(context))) } }),
    getArtist: async (context) => {
      const artist = await catalog.artist(required(context, 'id'), uid(context))
      if (!artist) throw notFound('Artist')
      return { artist: { ...artistToID3(artist), album: (await catalog.artistAlbums(artist.id, uid(context))).map(albumToID3) } }
    },
    getAlbum: async (context) => {
      const album = await catalog.album(required(context, 'id'), uid(context))
      if (!album) throw notFound('Album')
      return { album: { ...albumToID3(album), song: (await catalog.albumSongs(album.id, uid(context))).map(songToChild) } }
    },
    getSong: async (context) => {
      const song = await catalog.song(required(context, 'id'), uid(context))
      if (!song) throw notFound('Song')
      return { song: songToChild(song) }
    },
    // Folder browsing, mapped onto the tag structure: artist → albums → songs.
    getMusicDirectory: async (context) => {
      const id = required(context, 'id')
      const artist = await catalog.artist(id, uid(context))
      if (artist) return { directory: { id: artist.id, name: artist.name, child: (await catalog.artistAlbums(artist.id, uid(context))).map(albumToChild) } }
      const album = await catalog.album(id, uid(context))
      if (album) return { directory: { id: album.id, parent: album.artist_id, name: album.name, child: (await catalog.albumSongs(album.id, uid(context))).map(songToChild) } }
      throw notFound('Directory')
    },
    getGenres: async () => ({ genres: { genre: await catalog.genres() } }),
    getArtistInfo2: () => ({ artistInfo2: {} }),
    getArtistInfo: () => ({ artistInfo: {} }),
    getAlbumInfo2: () => ({ albumInfo: {} }),
    getAlbumInfo: () => ({ albumInfo: {} }),
    getTopSongs: async (context) => ({ topSongs: { song: (await catalog.topSongs(required(context, 'artist'), int(context.param('count'), 50, 500), uid(context))).map(songToChild) } }),
    getSimilarSongs2: async (context) => {
      const id = required(context, 'id')
      const kind = catalog.kindOf(id)
      let seed: string | undefined
      if (kind === 'song') seed = id
      else if (kind === 'album') seed = (await catalog.albumSongs(id))[0]?.id
      else if (kind === 'artist') {
        const album = (await catalog.artistAlbums(id))[0]
        seed = album ? (await catalog.albumSongs(album.id))[0]?.id : undefined
      }
      if (!seed) throw notFound('Item')
      const ids = await recommender.recommend({ user: uid(context), seed, limit: int(context.param('count'), 50, 500), context: 'similar' })
      return { similarSongs2: { song: await children(ids, uid(context)) } }
    },

    /* ---------------- Lists ---------------- */
    getAlbumList2: async (context) => ({ albumList2: { album: (await albumList(context)).map(albumToID3) } }),
    getAlbumList: async (context) => ({ albumList: { album: (await albumList(context)).map(albumToChild) } }),
    getRandomSongs: async (context) => ({
      randomSongs: {
        song: (
          await catalog.randomSongs(
            {
              size: int(context.param('size'), 10, 500),
              genre: context.param('genre'),
              fromYear: context.param('fromYear') ? int(context.param('fromYear'), 0) : undefined,
              toYear: context.param('toYear') ? int(context.param('toYear'), 9999) : undefined,
            },
            uid(context),
          )
        ).map(songToChild),
      },
    }),
    getSongsByGenre: async (context) => ({
      songsByGenre: { song: (await catalog.songsByGenre(required(context, 'genre'), int(context.param('count'), 10, 500), int(context.param('offset'), 0), uid(context))).map(songToChild) },
    }),
    getStarred2: async (context) => {
      const starred = await catalog.starred(uid(context))
      return { starred2: { artist: starred.artists.map(artistToID3), album: starred.albums.map(albumToID3), song: starred.songs.map(songToChild) } }
    },
    getStarred: async (context) => {
      const starred = await catalog.starred(uid(context))
      return { starred: { artist: starred.artists.map(artistToID3), album: starred.albums.map(albumToChild), song: starred.songs.map(songToChild) } }
    },
    getNowPlaying: () => ({ nowPlaying: {} }),

    /* ---------------- Search ---------------- */
    search3: async (context) => {
      const result = await search(context)
      return { searchResult3: { artist: result.artists.map(artistToID3), album: result.albums.map(albumToID3), song: result.songs.map(songToChild) } }
    },
    search2: async (context) => {
      const result = await search(context)
      return { searchResult2: { artist: result.artists.map(artistToID3), album: result.albums.map(albumToChild), song: result.songs.map(songToChild) } }
    },

    /* ---------------- Playlists ---------------- */
    getPlaylists: async (context) => ({ playlists: { playlist: (await catalog.playlists(uid(context))).map(playlistToSubsonic) } }),
    getPlaylist: async (context) => {
      const playlist = await catalog.playlist(required(context, 'id'))
      if (!playlist || (playlist.owner_id !== uid(context) && !playlist.public)) throw notFound('Playlist')
      return { playlist: { ...playlistToSubsonic(playlist), entry: await children(await catalog.playlistSongIds(playlist.id), uid(context)) } }
    },
    createPlaylist: async (context) => {
      const songs = context.all('songId')
      const existing = context.param('playlistId')
      let id: string
      if (existing) {
        const playlist = await ownPlaylist(context, existing)
        await catalog.setPlaylistSongs(playlist.id, songs)
        id = playlist.id
      } else {
        id = await catalog.createPlaylist(uid(context), required(context, 'name'), songs)
      }
      const playlist = (await catalog.playlist(id))!
      return { playlist: { ...playlistToSubsonic(playlist), entry: await children(await catalog.playlistSongIds(id), uid(context)) } }
    },
    updatePlaylist: async (context) => {
      const playlist = await ownPlaylist(context, required(context, 'playlistId'))
      const isPublic = context.param('public')
      if (isPublic === 'true' && !context.can('playlists.public')) throw new SubsonicError(ERRORS.notAuthorized, 'You may not make playlists public')
      await catalog.updatePlaylist(playlist.id, { name: context.param('name'), comment: context.param('comment'), public: isPublic === undefined ? undefined : isPublic === 'true' })
      const remove = new Set(context.all('songIndexToRemove').map((index) => Number(index)))
      const adding = context.all('songIdToAdd')
      if (remove.size > 0 || adding.length > 0) {
        const songs = (await catalog.playlistSongIds(playlist.id)).filter((_, index) => !remove.has(index))
        await catalog.setPlaylistSongs(playlist.id, [...songs, ...adding])
      }
      return {}
    },
    deletePlaylist: async (context) => {
      await catalog.deletePlaylist((await ownPlaylist(context, required(context, 'id'))).id)
      return {}
    },

    /* ---------------- Annotation ---------------- */
    star: async (context) => {
      await catalog.star(uid(context), [...context.all('id'), ...context.all('albumId'), ...context.all('artistId')], true)
      return {}
    },
    unstar: async (context) => {
      await catalog.star(uid(context), [...context.all('id'), ...context.all('albumId'), ...context.all('artistId')], false)
      return {}
    },
    setRating: async (context) => {
      await catalog.setRating(uid(context), required(context, 'id'), int(required(context, 'rating'), 0, 5))
      return {}
    },
    scrobble: async (context) => {
      // Only submissions count as plays ("now playing" notifications don't).
      if (context.param('submission') === 'false') return {}
      const times = context.all('time')
      const known = new Set((await catalog.songs(context.all('id'))).map((song) => song.id))
      for (const [index, id] of context.all('id').entries()) {
        if (known.has(id)) await catalog.scrobble(uid(context), id, times[index] ? Number(times[index]) : Date.now())
      }
      return {}
    },

    /* ---------------- Play queues and bookmarks ---------------- */
    getPlayQueue: async (context) => {
      const queue = await catalog.playQueue(uid(context))
      if (!queue) return {}
      return {
        playQueue: {
          current: queue.current_index !== null ? queue.song_ids[queue.current_index] : undefined,
          position: queue.position_ms,
          username: context.user.name,
          changed: iso(queue.changed),
          changedBy: queue.changed_by,
          entry: await children(queue.song_ids, uid(context)),
        },
      }
    },
    savePlayQueue: async (context) => {
      const ids = context.all('id')
      const current = context.param('current')
      const index = current ? ids.indexOf(current) : -1
      await catalog.savePlayQueue(uid(context), { songIds: ids, currentIndex: index >= 0 ? index : ids.length ? 0 : null, positionMs: int(context.param('position'), 0), changedBy: context.param('c') ?? '' })
      return {}
    },
    // indexBasedQueue: the same, but the current song is an index (the queue may repeat songs).
    getPlayQueueByIndex: async (context) => {
      const queue = await catalog.playQueue(uid(context))
      if (!queue) return {}
      return {
        playQueueByIndex: {
          currentIndex: queue.current_index ?? undefined,
          position: queue.position_ms,
          username: context.user.name,
          changed: iso(queue.changed),
          changedBy: queue.changed_by,
          entry: await children(queue.song_ids, uid(context)),
        },
      }
    },
    savePlayQueueByIndex: async (context) => {
      const ids = context.all('id')
      const raw = context.param('currentIndex')
      const index = raw === undefined ? (ids.length ? 0 : null) : int(raw, 0)
      if (index !== null && ids.length > 0 && index >= ids.length) throw new SubsonicError(ERRORS.generic, 'currentIndex is outside the queue')
      await catalog.savePlayQueue(uid(context), { songIds: ids, currentIndex: index, positionMs: int(context.param('position'), 0), changedBy: context.param('c') ?? '' })
      return {}
    },
    getBookmarks: async (context) => {
      const bookmarks = await catalog.bookmarks(uid(context))
      const songs = new Map((await catalog.songs(bookmarks.map((bookmark) => bookmark.song_id), uid(context))).map((song) => [song.id, song]))
      return {
        bookmarks: {
          bookmark: bookmarks
            .filter((bookmark) => songs.has(bookmark.song_id))
            .map((bookmark) => ({
              position: bookmark.position_ms,
              username: context.user.name,
              comment: bookmark.comment ?? undefined,
              created: iso(bookmark.created),
              changed: iso(bookmark.changed),
              entry: songToChild(songs.get(bookmark.song_id) as SongRow),
            })),
        },
      }
    },
    createBookmark: async (context) => {
      const id = required(context, 'id')
      if (!(await catalog.song(id))) throw notFound('Song')
      await catalog.saveBookmark(uid(context), id, int(required(context, 'position'), 0), context.param('comment'))
      return {}
    },
    deleteBookmark: async (context) => {
      await catalog.deleteBookmark(uid(context), required(context, 'id'))
      return {}
    },

    /* ---------------- Media ---------------- */
    stream: async (context) => {
      const song = await catalog.song(required(context, 'id'), uid(context))
      if (!song) throw notFound('Song')
      return media.stream(song, {
        range: context.request.headers.get('range') ?? undefined,
        maxBitRate: int(context.param('maxBitRate'), 0) || undefined,
        user: uid(context),
        // Noctis: one specific source ("provider:externalId"), as listed by /api/noctis/v1/songs/:id/sources.
        only: context.param('source'),
      })
    },
    download: async (context) => {
      const song = await catalog.song(required(context, 'id'), uid(context))
      if (!song) throw notFound('Song')
      const response = await media.stream(song, { range: context.request.headers.get('range') ?? undefined, user: uid(context), only: context.param('source') })
      const headers = new Headers(response.headers)
      const name = `${song.artist_name} - ${song.title}.${song.suffix ?? 'audio'}`.replace(/["\\/\r\n]/g, '_')
      headers.set('content-disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      return new Response(response.body, { status: response.status, headers })
    },
    getCoverArt: (context) => media.cover(required(context, 'id')),
  }

  function albumList(context: SubsonicContext) {
    const type = required(context, 'type') as AlbumListType
    const types: AlbumListType[] = ['random', 'newest', 'frequent', 'recent', 'starred', 'highest', 'alphabeticalByName', 'alphabeticalByArtist', 'byYear', 'byGenre']
    if (!types.includes(type)) throw new SubsonicError(ERRORS.generic, `Unknown list type "${type}"`)
    if (type === 'byYear') {
      required(context, 'fromYear')
      required(context, 'toYear')
    }
    if (type === 'byGenre') required(context, 'genre')
    return catalog.albumList(
      type,
      {
        size: int(context.param('size'), 10, 500),
        offset: int(context.param('offset'), 0),
        fromYear: context.param('fromYear') ? int(context.param('fromYear'), 0) : undefined,
        toYear: context.param('toYear') ? int(context.param('toYear'), 9999) : undefined,
        genre: context.param('genre'),
      },
      context.user.id,
    )
  }

  function search(context: SubsonicContext) {
    return catalog.search(
      context.param('query') ?? '',
      {
        artist: [int(context.param('artistCount'), 20, 500), int(context.param('artistOffset'), 0)],
        album: [int(context.param('albumCount'), 20, 500), int(context.param('albumOffset'), 0)],
        song: [int(context.param('songCount'), 20, 500), int(context.param('songOffset'), 0)],
      },
      context.user.id,
    )
  }

  async function ownPlaylist(context: SubsonicContext, id: string) {
    const playlist = await catalog.playlist(id)
    if (!playlist) throw notFound('Playlist')
    if (playlist.owner_id !== context.user.id && !context.can('*')) throw new SubsonicError(ERRORS.notAuthorized, 'Not your playlist')
    return playlist
  }
}

const BUILT_IN = new Set(Object.keys(endpoints({} as Services)))

async function readParams(request: Request): Promise<Params> {
  const params: Params = new Map()
  const add = (key: string, value: string) => params.set(key, [...(params.get(key) ?? []), value])
  for (const [key, value] of new URL(request.url).searchParams) add(key, value)
  // formPost: the same parameters in an application/x-www-form-urlencoded body.
  if (request.method === 'POST' && (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    for (const [key, value] of new URLSearchParams(await request.text())) add(key, value)
  }
  return params
}

async function authenticate(services: Services, params: Params): Promise<User> {
  const first = (name: string) => params.get(name)?.[0]
  if (first('u') || first('p') || first('t') || first('s')) {
    throw new SubsonicError(
      ERRORS.authMechanismUnsupported,
      'Only API keys are accepted (apiKeyAuthentication). Get one by signing in with a Noctis client, or POST /api/noctis/v1/auth/login.',
    )
  }
  try {
    const user = await services.authenticate(first('apiKey'))
    if (!user) throw new SubsonicError(ERRORS.missingParameter, 'An API key is required (apiKey)')
    return user
  } catch (error) {
    if (error instanceof AuthError) throw new SubsonicError(error.code, error.message)
    throw error
  }
}

export function createSubsonic(services: Services, serverVersion: string) {
  const handlers = endpoints(services)
  const { hooks, subsonic: registry } = services

  return async function handle(request: Request, endpointPath: string): Promise<Response> {
    const endpoint = endpointPath.replace(/\.view$/, '')
    const params = await readParams(request).catch(() => new Map() as Params)
    const format = params.get('f')?.[0]
    const fail = (code: number, message: string) => render(envelope(serverVersion, { error: { code, message } }, 'failed'), format)

    try {
      const builtIn = handlers[endpoint]
      const handler = builtIn ?? registry.endpoints.get(endpoint)?.handler
      if (!handler) throw new SubsonicError(ERRORS.notFound, `Unknown endpoint "${endpoint}"`)

      // getOpenSubsonicExtensions answers without credentials (OpenSubsonic requires it).
      const user: User =
        endpoint === 'getOpenSubsonicExtensions'
          ? { id: 0, name: '', groups: [], permissions: [], guest: true }
          : await authenticate(services, params)
      const needs = Object.hasOwn(handlers, endpoint) ? NEEDS[endpoint] : undefined
      if (needs?.permission && !can(user, needs.permission)) throw new SubsonicError(ERRORS.notAuthorized, `You don't have the "${needs.permission}" permission`)
      if (needs?.account && user.guest) throw new SubsonicError(ERRORS.notAuthorized, 'Sign in to an account for this')

      const context: SubsonicContext = {
        endpoint,
        params,
        param: (name) => params.get(name)?.[0],
        all: (name) => params.get(name) ?? [],
        user,
        can: (permission) => can(user, permission),
        request,
      }

      const before = await hooks.runBefore<Payload | Response>('onSubsonic', { endpoint, params, user, request })
      let result = before.stopped ? before.response : await handler(context)
      if (result instanceof Response) return result

      const call = { endpoint, params, user, request, response: result }
      const after = await hooks.run<Payload>('onSubsonic', 'after', call)
      result = after.stopped ? after.response : call.response
      return render(envelope(serverVersion, result), format)
    } catch (error) {
      if (error instanceof SubsonicError) return fail(error.code, error.message)
      if (error instanceof MediaError) {
        // Media endpoints: a plain HTTP error suits players better than an envelope.
        return error.status === 404 ? fail(ERRORS.notFound, error.message) : new Response(error.message, { status: error.status })
      }
      writeLog('noctis', 'error', `OpenSubsonic ${endpoint} failed:`, error)
      return fail(ERRORS.generic, 'Internal error')
    }
  }
}
