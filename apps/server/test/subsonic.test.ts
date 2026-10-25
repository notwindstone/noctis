import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseManifest, writePluginArchive } from '@noctis/plugin-core'
import { login, startTestServer, wav, type TestServer } from './helpers'

const LOCAL_LIBRARY = join(import.meta.dir, '../../../examples/plugins/local-library')

let server: TestServer
let key = ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>

const rest = (endpoint: string, params: Record<string, string | string[]> = {}, init: RequestInit = {}) => {
  const url = new URL(`http://noctis.test/rest/${endpoint}`)
  for (const [name, value] of Object.entries(params)) for (const item of [value].flat()) url.searchParams.append(name, item)
  return server.fetch(new Request(url.href, init))
}
const json = async (endpoint: string, params: Record<string, string | string[]> = {}, apiKey = key): Promise<Body> => {
  const response = await rest(endpoint, { f: 'json', ...(apiKey ? { apiKey } : {}), ...params })
  return ((await response.json()) as { 'subsonic-response': Body })['subsonic-response']
}
const noctis = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
  server.fetch(
    new Request(`http://noctis.test/noctis/v1${path}`, {
      ...init,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.token !== '' ? { authorization: `Bearer ${init.token ?? key}` } : {}) },
    }),
  )

beforeAll(async () => {
  server = await startTestServer({}, async (dataDir) => {
    const music = join(dataDir, 'music', 'Mitsukiyo', 'Blue Archive OST')
    await mkdir(music, { recursive: true })
    await writeFile(join(music, '01 Luminous Memory.wav'), wav({ INAM: 'Luminous Memory', IART: 'Mitsukiyo', IPRD: 'Blue Archive OST', IGNR: 'Soundtrack', ICRD: '2021', ITRK: '1' }))
    await writeFile(join(music, '02 Unwelcome School.wav'), wav({ INAM: 'Unwelcome School', IART: 'Mitsukiyo', IPRD: 'Blue Archive OST', IGNR: 'Soundtrack', ICRD: '2021', ITRK: '2' }))
    await writeFile(join(music, 'cover.jpg'), 'JPEGDATA')
    await mkdir(join(dataDir, 'music', 'Other'), { recursive: true })
    await writeFile(join(dataDir, 'music', 'Other', 'Night Drive.wav'), wav({ INAM: 'Night Drive', IART: 'Someone Else', IPRD: 'Roads', IGNR: 'Synthwave', ICRD: '1986' }))
    process.env.LOCAL_LIBRARY_DIRS = join(dataDir, 'music')

    await mkdir(join(dataDir, 'plugins'), { recursive: true })
    // The real local-library plugin, built from its source.
    const built = await Bun.build({ entrypoints: [join(LOCAL_LIBRARY, 'src/server.ts')], target: 'bun', format: 'esm', external: ['elysia'] })
    await writeFile(
      join(dataDir, 'plugins', 'local-library.noctis'),
      writePluginArchive({ manifest: parseManifest(await Bun.file(join(LOCAL_LIBRARY, 'metadata.json')).json()), server: await built.outputs[0].text() }),
    )
    // A service plugin: one song also found locally (they merge), one only it has, an
    // OpenSubsonic extension, and hooks.
    await writeFile(
      join(dataDir, 'plugins', 'fakemusic.noctis'),
      writePluginArchive({
        manifest: parseManifest({ name: 'Fake Music', type: 'unrestricted', side: 'server', version: '1.0.0' }),
        server: `export default async ({ Plugin, Noctis }) => {
          Plugin.defineProvider('fakemusic', {
            name: 'Fake Music',
            clientService: 'youtube-music',
            clientPlugin: 'youtube-music',
            stream: async ({ source }) => new Response('FAKEAUDIO-' + source.external_id, { headers: { 'content-type': 'audio/webm' } }),
          })
          await Noctis.catalog.upsertSong({ title: 'Luminous Memory', artist: 'Mitsukiyo', album: 'Blue Archive OST',
            source: { provider: 'fakemusic', externalId: 'yt-123', contentType: 'audio/webm', suffix: 'webm', bitrate: 160 } })
          // A provider only clients can play: no stream().
          Plugin.defineProvider('clientonly', { name: 'Client only', clientService: 'client-only-service', clientPlugin: 'client-only' })
          await Noctis.catalog.upsertSong({ title: 'Night Drive', artist: 'Someone Else', album: 'Roads', disc: 1,
            source: { provider: 'clientonly', externalId: 'co-1' } })
          await Noctis.catalog.upsertSong({ title: 'Only Online', artist: 'Mitsukiyo', album: 'Singles',
            source: { provider: 'fakemusic', externalId: 'yt-456', contentType: 'audio/webm', suffix: 'webm', bitrate: 160 } })
          Plugin.subsonic.extension('noctisHello', [1])
          Plugin.subsonic.endpoint('getNoctisHello', ({ user, can }) => ({ hello: { user: user.name, admin: can('*') } }))
          Plugin.permissions.define('fakemusic.premium', 'Lossless from Fake Music')
          Plugin.subscribe('hook::onSubsonic::after', (call) => { if (call.endpoint === 'ping') call.response.pluginWasHere = true })
          Plugin.subscribe('hook::onSources::after', (result) => {
            result.sources.push({ key: 'mirror:1', provider: 'mirror', name: 'A mirror', externalId: '1', stream: null,
              clientService: 'mirror-service', clientPlugin: 'mirror', install: null, lossless: false })
          })
          Plugin.subscribe('hook::onRecommend::after', async (result) => {
            const id = (await Noctis.catalog.search('Only Online', { artist: [0, 0], album: [0, 0], song: [1, 0] })).songs[0]?.id
            if (id) result.songIds = [id, ...result.songIds.filter((other) => other !== id)]
          })
        }`,
      }),
    )
  })
  // Wait for the local library's startup scan.
  while (server.services.scanners.status().scanning || server.services.scanners.status().count === 0) await Bun.sleep(20)
  key = await login(server)
})

afterAll(async () => {
  delete process.env.LOCAL_LIBRARY_DIRS
  await server.close()
})

describe('auth', () => {
  test('only API keys: legacy Subsonic auth is refused', async () => {
    expect((await json('ping')).status).toBe('ok')
    expect((await json('ping', { u: 'sensei', p: 'correct-horse' }, '')).error.code).toBe(42)
    expect((await json('ping', { u: 'sensei', p: `enc:${Buffer.from('correct-horse').toString('hex')}` }, '')).error.code).toBe(42)
    expect((await json('ping', { u: 'sensei', t: 'abc', s: 'salt' }, '')).error.code).toBe(42)
    expect((await json('ping', { u: 'sensei' })).error.code).toBe(42)
    expect((await json('ping', {}, 'nk_nope')).error.code).toBe(44)
    expect((await json('ping', {}, '')).error.code).toBe(10)
  })

  test('no JSONP', async () => {
    const response = await rest('ping', { apiKey: key, f: 'jsonp', callback: 'steal' })
    expect(response.headers.get('content-type')).toContain('xml')
  })

  test('extensions are listed without auth, including a plugin\'s', async () => {
    const body = await json('getOpenSubsonicExtensions', {}, '')
    expect(body.openSubsonic).toBe(true)
    expect(body.openSubsonicExtensions.map((ext: { name: string }) => ext.name)).toEqual(['apiKeyAuthentication', 'formPost', 'indexBasedQueue', 'noctis', 'noctisHello'])
  })

  test('sessions: logout and password changes revoke them', async () => {
    const extra = await login(server)
    expect((await json('ping', {}, extra)).status).toBe('ok')
    await noctis('/auth/logout', { method: 'POST', token: extra })
    expect((await json('ping', {}, extra)).error.code).toBe(44)

    await noctis('/admin/users', { method: 'POST', json: { username: 'hoshino', password: 'whale-and-shark', groups: ['users'] } })
    const hers = await login(server, 'hoshino', 'whale-and-shark')
    expect((await json('ping', {}, hers)).status).toBe('ok')
    await noctis('/admin/users/hoshino', { method: 'PATCH', json: { password: 'a-new-password' } })
    expect((await json('ping', {}, hers)).error.code).toBe(44)
  })
})

describe('groups and permissions', () => {
  test('a user with fewer permissions, and the admin API', async () => {
    // A group that may browse but not download.
    expect((await noctis('/admin/groups/listeners', { method: 'PUT', json: { description: 'Browse and stream', permissions: ['library.read', 'stream'] } })).status).toBe(200)
    expect((await noctis('/admin/groups/bad', { method: 'PUT', json: { permissions: ['nope'] } })).status).toBe(400)
    await noctis('/admin/users', { method: 'POST', json: { username: 'arona', password: 'shittim-chest', groups: ['listeners'] } })
    const arona = await login(server, 'arona', 'shittim-chest')

    const song = (await json('search3', { query: 'Unwelcome' })).searchResult3.song[0]
    expect((await rest('stream', { id: song.id, apiKey: arona })).status).toBe(200)
    expect((await json('download', { id: song.id }, arona)).error.code).toBe(50)
    expect((await json('star', { id: song.id }, arona)).error.code).toBe(50)
    expect((await noctis('/admin/users', { token: arona })).status).toBe(403)

    const me = (await (await noctis('/me', { token: arona })).json()) as Body
    expect(me.groups).toEqual(['listeners'])
    const permissions = ((await (await noctis('/admin/permissions')).json()) as { name: string }[]).map((permission) => permission.name)
    expect(permissions).toContain('fakemusic.premium')
    expect(permissions).toContain('local-library.manage')
    expect((await json('getNoctisHello')).hello).toEqual({ user: 'sensei', admin: true })
  })

  test("admins can't lock themselves out", async () => {
    expect((await noctis('/admin/users/sensei', { method: 'PATCH', json: { groups: ['users'] } })).status).toBe(400)
    expect((await noctis('/admin/groups/admins', { method: 'DELETE' })).status).toBe(400)
  })
})

describe('browsing', () => {
  test('artists, albums and merged songs', async () => {
    const artists = (await json('getArtists')).artists.index.flatMap((index: Body) => index.artist.map((artist: Body) => artist.name))
    expect(artists).toEqual(['Mitsukiyo', 'Someone Else'])
    const mitsukiyo = (await json('search3', { query: 'Mitsukiyo' })).searchResult3.artist[0]
    const artist = (await json('getArtist', { id: mitsukiyo.id })).artist
    expect(artist.album.map((album: Body) => album.name).sort()).toEqual(['Blue Archive OST', 'Singles'])
    const ost = artist.album.find((album: Body) => album.name === 'Blue Archive OST')
    const album = (await json('getAlbum', { id: ost.id })).album
    expect(album.song.map((song: Body) => `${song.track} ${song.title}`)).toEqual(['1 Luminous Memory', '2 Unwelcome School'])
    expect(album.year).toBe(2021)
    // The local lossless WAV beats the plugin's 160 kbps source.
    expect(album.song[0].suffix).toBe('wav')
  })

  test('lists, genres, random songs, search, XML', async () => {
    expect((await json('getAlbumList2', { type: 'alphabeticalByName', size: '10' })).albumList2.album.map((album: Body) => album.name)).toEqual(['Blue Archive OST', 'Roads', 'Singles'])
    expect((await json('getAlbumList2', { type: 'byYear', fromYear: '1980', toYear: '1990' })).albumList2.album.map((album: Body) => album.name)).toEqual(['Roads'])
    expect((await json('getGenres')).genres.genre.map((genre: Body) => genre.value)).toEqual(['Soundtrack', 'Synthwave'])
    expect((await json('getRandomSongs', { size: '50' })).randomSongs.song).toHaveLength(4)
    expect((await json('search3', { query: 'drive' })).searchResult3.song[0].title).toBe('Night Drive')
    const xml = await (await rest('getGenres', { apiKey: key })).text()
    expect(xml).toContain('<genre songCount="2" albumCount="1">Soundtrack</genre>')
  })
})

describe('media', () => {
  test('a local file, with Range', async () => {
    const song = (await json('search3', { query: 'Unwelcome' })).searchResult3.song[0]
    const full = await rest('stream', { id: song.id, apiKey: key })
    const size = (await full.arrayBuffer()).byteLength
    expect(size).toBe(song.size)
    const part = await rest('stream', { id: song.id, apiKey: key }, { headers: { range: 'bytes=0-99' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${size}`)
  })

  test('cover art from the album folder', async () => {
    const song = (await json('search3', { query: 'Luminous' })).searchResult3.song[0]
    expect(await (await rest('getCoverArt', { id: song.coverArt, apiKey: key })).text()).toBe('JPEGDATA')
  })

  test('one exact source', async () => {
    const song = (await json('search3', { query: 'Luminous' })).searchResult3.song[0]
    expect(await (await rest('stream', { id: song.id, apiKey: key, source: 'fakemusic:yt-123' })).text()).toBe('FAKEAUDIO-yt-123')
    expect((await json('stream', { id: song.id, source: 'nope:1' })).error.code).toBe(70)
  })
})

describe('play queues and bookmarks', () => {
  test('save and restore a queue', async () => {
    const songs = (await json('getAlbumList2', { type: 'alphabeticalByName' })).albumList2.album
    const tracks = (await json('getAlbum', { id: songs[0].id })).album.song.map((song: Body) => song.id)
    expect(await json('getPlayQueue')).not.toHaveProperty('playQueue')
    await json('savePlayQueue', { id: tracks, current: tracks[1], position: '42000', c: 'test-client' })
    const queue = (await json('getPlayQueue')).playQueue
    expect(queue.entry.map((song: Body) => song.id)).toEqual(tracks)
    expect(queue.current).toBe(tracks[1])
    expect(queue.position).toBe(42000)
    expect(queue.changedBy).toBe('test-client')

    // By index: the same song twice is fine.
    await json('savePlayQueueByIndex', { id: [tracks[0], tracks[0], tracks[1]], currentIndex: '1', position: '5' })
    const byIndex = (await json('getPlayQueueByIndex')).playQueueByIndex
    expect(byIndex.currentIndex).toBe(1)
    expect(byIndex.entry).toHaveLength(3)
    expect((await json('savePlayQueueByIndex', { id: tracks[0], currentIndex: '4' })).error.code).toBe(0)
  })

  test('bookmarks', async () => {
    const song = (await json('search3', { query: 'Night Drive' })).searchResult3.song[0]
    await json('createBookmark', { id: song.id, position: '90500', comment: 'the drop' })
    let bookmarks = (await json('getBookmarks')).bookmarks.bookmark
    expect(bookmarks).toHaveLength(1)
    expect(bookmarks[0]).toMatchObject({ position: 90500, comment: 'the drop', username: 'sensei' })
    expect(bookmarks[0].entry.id).toBe(song.id)
    await json('createBookmark', { id: song.id, position: '1000' })
    expect((await json('getBookmarks')).bookmarks.bookmark[0].position).toBe(1000)
    await json('deleteBookmark', { id: song.id })
    bookmarks = (await json('getBookmarks')).bookmarks.bookmark ?? []
    expect(bookmarks).toHaveLength(0)
    expect((await json('createBookmark', { id: 'so-nope', position: '1' })).error.code).toBe(70)
  })
})

describe('annotation and playlists', () => {
  test('star, scrobble, playlists', async () => {
    const songs = (await json('getRandomSongs', { size: '10' })).randomSongs.song as Body[]
    await json('star', { id: songs[0].id, albumId: songs[0].albumId })
    const starred = (await json('getStarred2')).starred2
    expect(starred.song[0].id).toBe(songs[0].id)
    await json('scrobble', { id: songs[1].id })
    await json('scrobble', { id: songs[1].id, submission: 'false' })
    expect((await json('getSong', { id: songs[1].id })).song.playCount).toBe(1)
    const created = (await json('createPlaylist', { name: 'Mix', songId: [songs[0].id, songs[1].id] })).playlist
    await json('updatePlaylist', { playlistId: created.id, songIdToAdd: songs[2].id, songIndexToRemove: '0' })
    expect((await json('getPlaylist', { id: created.id })).playlist.entry.map((song: Body) => song.id)).toEqual([songs[1].id, songs[2].id])
    await json('deletePlaylist', { id: created.id })
    expect((await json('getPlaylists')).playlists.playlist ?? []).toHaveLength(0)
  })
})

describe('sources ("Play from")', () => {
  test('every source of a song, plus what plugins add', async () => {
    const song = (await json('search3', { query: 'Luminous' })).searchResult3.song[0]
    const body = (await (await noctis(`/songs/${song.id}/sources`)).json()) as Body
    expect(body.stream).toBe(`/rest/stream?id=${song.id}`)
    expect(body.sources.map((source: Body) => [source.provider, source.lossless, source.clientService, source.clientPlugin, Boolean(source.stream)])).toEqual([
      ['local', true, null, null, true],
      ['fakemusic', false, 'youtube-music', 'youtube-music', true],
      ['mirror', false, 'mirror-service', 'mirror', false],
    ])
    expect(body.sources[1].stream).toBe(`/rest/stream?id=${song.id}&source=fakemusic%3Ayt-123`)
    // The local source id doesn't reveal server paths.
    expect(body.sources[0].externalId).toMatch(/^[0-9a-f]{10}\/Mitsukiyo\/Blue Archive OST\/01 Luminous Memory\.wav$/)
  })

  test('client-only providers: listed for Noctis clients, never streamed by the server', async () => {
    const song = (await json('search3', { query: 'Night Drive' })).searchResult3.song[0]
    const body = (await (await noctis(`/songs/${song.id}/sources`)).json()) as Body
    const clientOnly = body.sources.find((source: Body) => source.provider === 'clientonly')
    expect(clientOnly).toMatchObject({ stream: null, clientService: 'client-only-service', clientPlugin: 'client-only' })
    expect((await json('stream', { id: song.id, source: 'clientonly:co-1' })).error.code).toBe(70)
  })

  test('many songs at once', async () => {
    const ids = ((await json('getRandomSongs', { size: '10' })).randomSongs.song as Body[]).map((song) => song.id)
    const body = (await (await noctis('/sources', { method: 'POST', json: { ids: [...ids, 'so-nope'] } })).json()) as Body
    expect(Object.keys(body.songs).sort()).toEqual([...ids].sort())
    expect((await noctis('/sources', { method: 'POST', token: '', json: { ids } })).status).toBe(401)
  })
})

describe('plugins', () => {
  test('extension endpoint, hooks on responses and recommendations', async () => {
    expect((await json('ping')).pluginWasHere).toBe(true)
    const body = (await (await noctis('/recommendations?limit=3')).json()) as { songs: Body[] }
    expect(body.songs[0].title).toBe('Only Online')
    expect((await noctis('/recommendations', { token: '' })).status).toBe(401)
  })

  test('local library: admin-only directories, rescans keep the catalog consistent', async () => {
    expect((await server.fetch(new Request('http://noctis.test/api/plugins/local-library/directories'))).status).toBe(403)
    const listed = (await (await server.fetch(new Request('http://noctis.test/api/plugins/local-library/directories', { headers: { authorization: `Bearer ${key}` } }))).json()) as Body
    expect(listed.directories).toEqual([join(server.dataDir, 'music')])
    expect(await server.services.catalog.counts()).toEqual({ songs: 4, albums: 3, artists: 2 })
    await rm(join(server.dataDir, 'music', 'Other'), { recursive: true })
    await json('startScan')
    while (server.services.scanners.status().scanning) await Bun.sleep(20)
    await Bun.sleep(50)
    // Night Drive's local file is gone, but the song stays: a plugin also provides it.
    expect(await server.services.catalog.counts()).toEqual({ songs: 4, albums: 3, artists: 2 })
    const nightDrive = (await json('search3', { query: 'Night Drive' })).searchResult3.song[0]
    expect((await server.services.catalog.sources(nightDrive.id)).map((source) => source.provider)).toEqual(['clientonly'])
  })
})

describe('guests', () => {
  test('instances without accounts: browse and stream, nothing per-user', async () => {
    await server.restart({ NOCTIS_GUEST_ACCESS: 'true' })
    expect((await json('ping', {}, '')).status).toBe('ok')
    const song = (await json('search3', { query: 'Luminous' }, '')).searchResult3.song[0]
    expect((await rest('stream', { id: song.id })).status).toBe(200)
    expect((await json('star', { id: song.id }, '')).error.code).toBe(50)
    expect((await json('getPlayQueue', {}, '')).error.code).toBe(50)
    expect((await json('download', { id: song.id }, '')).error.code).toBe(50)
    expect(((await (await noctis('/me', { token: '' })).json()) as Body).guest).toBe(true)
  })
})
