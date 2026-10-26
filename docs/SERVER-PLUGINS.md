# The server and its plugins

A Noctis server (`apps/server`) runs on Bun + Elysia 2, with PostgreSQL and Redis. It has
three parts:

| Path | |
| --- | --- |
| `/rest/*` | **OpenSubsonic**, for OpenSubsonic clients (API keys only) |
| `/api/noctis/v1/*` | **Noctis**: sources ("Play from"), recommendations, accounts, administration, plugin negotiation |
| `/api/plugins/<id>/*` | each **plugin's own routes** |

Plugins extend all three. A plugin can run on one side or on both. When it runs on both,
the server can **require clients to have its client half**, the way a modded Minecraft
server refuses players without its mods.

Client plugins are covered in [PLUGINS.md](PLUGINS.md). Both sides share one plugin
system, [`packages/plugin-core`](../packages/plugin-core):

- the archive and manifest format;
- versions and dependency ranges;
- load order;
- the hook engine;
- the `Plugin` base: lifecycle, hook events and logging;
- client–server negotiation.

## Running a server

```sh
docker compose up -d                                   # PostgreSQL and Redis
bun run pack-plugin examples/plugins/local-library     # files on the server, as a plugin
mkdir -p apps/server/data/plugins && cp dist-plugins/local-library.noctis apps/server/data/plugins/
NOCTIS_ADMIN_USER=admin NOCTIS_ADMIN_PASSWORD=change-me LOCAL_LIBRARY_DIRS=~/Music bun run dev:server
```

- **Admin account:** created on the first start, in the `admins` group.
- **Noctis client:** **Settings → Server**. Enter the address, then sign in under
  **Settings → Accounts**. Set **Settings → Playback → Play from**, or choose per song from
  the player's menu.
- **Other OpenSubsonic apps:** they need an API key. A session token from
  `POST /api/noctis/v1/auth/login` is one. Password-based Subsonic logins are refused by
  this server (the Noctis client itself can still use them against servers that need them).
- **Tests:** `bun test` needs PostgreSQL and Redis. Point it at them with
  `NOCTIS_TEST_DATABASE_URL` and `NOCTIS_TEST_REDIS_URL`; the defaults are the compose
  ports. Each test file gets its own throwaway database.

## The catalog: one song, many sources

The server keeps its own music database. Songs come from plugins:

- **local files**, from the local-library plugin;
- **services**, which plugins index with `Noctis.catalog.upsertSong(…)`.

A song found in several places becomes **one song with several sources**: ids are
derived from artist, album and title. Each source records its codec, bitrate, sample
rate and whether it's lossless. Two kinds of client use those sources differently:

- **OpenSubsonic clients** play `/rest/stream`. The server streams the best source it
  can play: lossless first, then by bitrate. It honours Range, so seeking works.
- **Noctis clients** get every source, for one song (`GET /api/noctis/v1/songs/:id/sources`)
  or up to 200 at once (`POST /api/noctis/v1/sources { ids }`). Each source carries:
  - `stream`: a `/rest/stream?id=…&source=<provider:externalId>` URL for exactly that
    source, or `null` if the server can't stream it;
  - `clientService`: the client-side service that can play it with the user's own
    account;
  - `clientPlugin`: which client plugin provides that service;
  - `install`: where to download that plugin, if this server has it.

  The client then chooses ("Play from"): a copy on the device, the user's own service,
  or any server stream.

## Sides

`metadata.json` says where a plugin runs with `"side"`:

| `side` | Archive contains | Runs |
| --- | --- | --- |
| `"client"` (default) | `index.js` | in the app |
| `"server"` | `server.js` | on the server; clients never see it |
| `"both"` | `index.js` and `server.js` | each half on its side |

```json
{
  "name": "Server charts",
  "version": "1.0.0",
  "side": "both",
  "type": "unrestricted",
  "dependencies": { "some-other-plugin": "^2.1.0" },
  "client": { "required": true, "versions": "^1.0.0" }
}
```

- `version` must be semver for `"server"` and `"both"` plugins.
- `dependencies` maps plugin ids to semver ranges. They're checked on each side the
  plugin runs on.
- `platforms` (default `["*"]`) lists the apps the client half runs in: `android`,
  `ios`, `web`, `desktop`. A client on another platform isn't asked for it, so a
  required Android-only plugin doesn't lock browsers out.
- `client` only applies to `"both"`:
  - `required` (default `true`): whether clients without the client half are refused.
  - `versions` (default `^<version>`): which client-half versions the server accepts.

To pack a folder, run `bun run pack-plugin path/to/folder`.
- **`src/server.ts`** instead of `server.js` is built with Bun, bundling its npm
  packages and leaving `elysia` to the server.
- **Unpacked plugin folders** in the plugins directory build `src/server.ts` when they
  load. Their npm packages must be resolvable from the folder.

## Installing

Server plugins are **trusted code** with the server's full access, as with Minecraft
server mods. Only the instance owner installs them, by putting them in the plugins
directory: `$NOCTIS_PLUGINS_DIR`, by default `data/plugins`. There is no API to install
plugins.

At startup the server:
- loads plugins with their dependencies first;
- skips any plugin whose dependency is missing, the wrong version, or failed to start,
  and logs why.

## The server half

`server.js` is an ES module whose default export is called once at startup (it may be
async):

```js
export default async function ({ Plugin, Noctis }) {
  const { t } = Noctis.packages.elysia // the server's Elysia, and its schema builder

  // Your own routes, under /api/plugins/<id>/ (Elysia 2: path, hook, handler)
  Plugin.routes((app) =>
    app.post('/plays', { body: t.Object({ id: t.String() }) }, async ({ body, request, status }) => {
      const user = await Noctis.auth.userFrom(request) // from Authorization: Bearer
      if (!user || !Noctis.auth.can(user, 'annotate')) return status(403, { error: 'Not allowed' })
      const plays = (await Plugin.storage.get(`plays:${body.id}`, 0)) + 1
      await Plugin.storage.set(`plays:${body.id}`, plays)
      return { plays }
    }),
  )

  Plugin.subscribe('lifecycle::disable', () => Plugin.removeAll())
}
```

### A music service

A service plugin does two things: it indexes songs into the catalog, and it defines a
provider for them.

```js
export default async function ({ Plugin, Noctis }) {
  Plugin.defineProvider('soundcloud', {
    name: 'SoundCloud',
    // Noctis clients with this service (from this client plugin) may play these sources themselves.
    clientService: 'soundcloud',
    clientPlugin: 'soundcloud',
    // A Response (streamed as is: honour `range`), or a URL the server relays. Leave
    // stream() out for a provider only clients can play.
    async stream({ song, source, range, maxBitRate }) {
      return await resolveAudioUrl(source.external_id)
    },
    // For covers given as "soundcloud:…" (https URLs need nothing).
    async cover(reference) { return null },
  })

  for (const track of await fetchTracks()) {
    await Noctis.catalog.upsertSong({
      title: track.title, artist: track.user, album: track.album, year: track.year, genre: track.genre,
      duration: track.seconds, cover: track.artworkUrl, tags: track.tags,
      source: { provider: 'soundcloud', externalId: track.id, contentType: 'audio/mpeg', suffix: 'mp3', bitrate: 128 },
    })
  }
}
```

### An indexer: the MusicBrainz plugin

[`examples/plugins/musicbrainz`](../examples/plugins/musicbrainz) fills the catalog with
what MusicBrainz knows (titles, artists, albums, track numbers, years, tags, Cover Art
Archive covers) and no audio. Its provider has no `stream()`, so `GET /api/noctis/v1/providers`
lists it with `streams: false`. Noctis clients play its songs with their own services:
the server says it has no audio, and the client falls back to a match on YouTube Music,
SoundCloud… (see "Finding a song on your service" in PLUGINS.md).
- **On search:** an OpenSubsonic `search3`/`search2` of three letters or more also searches
  MusicBrainz, and waits for it up to `MUSICBRAINZ_SEARCH_TIMEOUT_MS` (2500). The
  query is read as "artist title" in either order. Results prefer official studio
  releases over live albums, compilations, covers and remixes. A query is looked up at
  most once a week. `MUSICBRAINZ_INDEX_SEARCHES=false` turns this off.
- **On request:** `POST /api/plugins/musicbrainz/import { "release": "<MBID>" }` or
  `{ "artist": "<MBID>" }` (an artist's official studio albums, in the background). It
  needs the `musicbrainz.import` permission, which admins have. `GET …/status` shows
  progress.
- **Politely:** one request a second, with back-off on 503. Set `MUSICBRAINZ_CONTACT` to a
  URL or e-mail for your instance; it goes in the User-Agent, as MusicBrainz asks.

A song MusicBrainz knows with the same artist, album and title as a file or another
service's song becomes the same catalog song, with its MusicBrainz id as one more source.

The catalog's own search matches each word of a query against the title, the artist or
the album, so "queen bohemian rhapsody" finds the song.

### Local files: the local-library plugin

[`examples/plugins/local-library`](../examples/plugins/local-library) scans the
directories an admin chooses, reads tags with music-metadata, and streams the files with
Range support.
- **Choosing directories:**
  - `LOCAL_LIBRARY_DIRS` (separated by `:`) on its first start;
  - later, `PUT /api/plugins/local-library/directories { "directories": […] }`, which
    needs the `local-library.manage` permission (admins have it).
- **Rescans:** OpenSubsonic `startScan`, or `POST /api/plugins/local-library/scan`.
- **Privacy:** source ids are a directory hash plus a relative path, so server paths
  never reach clients.

### An OpenSubsonic extension

```js
export default function ({ Plugin, Noctis }) {
  Plugin.subsonic.extension('lyricsBySongId', [1])        // listed in getOpenSubsonicExtensions
  Plugin.subsonic.endpoint('getLyricsBySongId', async ({ param, user, can }) => {
    const song = await Noctis.catalog.song(param('id'), user.id)
    return { lyricsList: { structuredLyrics: [] } }        // merged into "subsonic-response"
  })
}
```

An endpoint returns a payload object, which is rendered as JSON or XML like the
built-in ones, or a `Response` for binary data.
- Built-in endpoints can't be replaced; change them with the `onSubsonic` hook.
- Two plugins can't register the same endpoint.
- Plugin endpoints need a signed-in user or guest. Check permissions yourself with
  `can(…)`.

### `Plugin`

The base is the same as on the client: `subscribe`/`unsubscribe` for hook and lifecycle
events, plus `log`, `warn` and `error`. On top of that:

| | |
| --- | --- |
| `Plugin.routes(build)` / `removeRoutes()` | Routes under `/api/plugins/<id>/`. `build` receives a fresh Elysia instance and returns it. |
| `Plugin.defineProvider(id, provider)` / `removeProvider(id)` | An audio provider for catalog sources (see above). |
| `Plugin.defineScanner(id, { name, scan, status })` / `removeScanner(id)` | Something `startScan` runs and `getScanStatus` reports. |
| `Plugin.permissions.define(name, description)` | A permission admins can grant to groups. The name must start with `<plugin id>.`. |
| `Plugin.subsonic.endpoint(name, handler)` / `.extension(name, versions)` | OpenSubsonic extensions at `/rest/<name>`. |
| `Plugin.removeAll()` | Undo routes, providers, scanners, OpenSubsonic endpoints and permissions. |
| `Plugin.storage.get` / `set` / `remove` / `keys(prefix)` / `entries(prefix)` | Async JSON key/value storage in PostgreSQL. Each plugin only sees its own keys. |

### `Noctis`

| | |
| --- | --- |
| `Noctis.catalog` | The catalog, async: `upsertSong`, `setTags(songId, tags)`, `removeSources(provider, keep?)`, `song(id)`, `songs(ids)`, `sources(id)`, `search(…)`, `album(id)`, `artist(id)`, `playQueue(user)`, `bookmarks(user)`… |
| `Noctis.auth.userFrom(request)`, `Noctis.auth.can(user, permission)` | Who's calling a plugin route (or the guest, or null), and what they may do. |
| `Noctis.recommend({ user, seed?, limit, context? })` | Recommendations, after every plugin's hooks. Resolves to song ids. |
| `Noctis.providers()` | Defined providers. |
| `Noctis.subsonic` | Mappers from catalog rows to OpenSubsonic objects: `songToChild`, `albumToID3`, `artistToID3`… |
| `Noctis.packages.elysia` | The server's Elysia module, including `t`. |
| `Noctis.hooks`, `Noctis.hookNames`, `Noctis.plugins()`, `Noctis.server.name`, `Noctis.log(…)` | Hook points, other plugins, the instance name, the server log. |

### Hooks

Subscribe with `Plugin.subscribe('hook::<name>::<before|after>', fn)`. Return
`{ status: 'stop', response }` to short-circuit, as on the client.

| Hook | `before` receives | `after` receives |
| --- | --- | --- |
| `onRequest` | `{ request, path, clientPlugins }`. Stop with a `Response` to answer it yourself: rate limits, bans. | |
| `onHandshake` | | `{ response }`, the handshake a client gets. |
| `onSubsonic` | `{ endpoint, params, user, request }`. Stop with a payload or `Response`. | `{ …, response }`. Change the payload, or stop with a replacement. |
| `onStream` | `{ song, sources, user, range }`. Reorder or filter `sources` in place, or stop with a `Response`. | |
| `onSources` | | `{ song, user, sources }`, what Noctis clients get. Add, remove or reorder sources. |
| `onRecommend` | `{ user, seed, limit, context }`. Stop with song ids to replace the algorithm. | `{ …, songIds }`. Reorder, filter or extend them. |

## Recommendations

OpenSubsonic has no recommendation API beyond `getSimilarSongs` and `getTopSongs`, so
recommendations live at `GET /api/noctis/v1/recommendations?seed=&limit=&context=`. They also
back `getSimilarSongs2`.

The built-in algorithm is a placeholder: co-listening, then shared artist, genre, tags and
era, then random songs. Today a plugin can change it with `onRecommend`, and set tags
with `catalog.setTags`.

The design for what comes next is in [RECOMMENDATIONS.md](RECOMMENDATIONS.md):
- **AI providers:** containers with custom models, or plugins, through
  `Plugin.defineAiProvider`;
- a job queue, and results tagged by model;
- song identity on MusicBrainz IDs;
- a rate-limited HTTP layer for plugins.

## Accounts, groups and sessions

- **Users** live in PostgreSQL. Passwords are stored only as Argon2 hashes.
- **Groups** grant permissions, and a user has their groups' combined permissions.
  Built-in groups:
  - **admins** have `*`.
  - **users** have `library.read`, `stream`, `download`, `annotate`, `playlists` and
    `queue`.
  - **guests** have `library.read` and `stream`.

  Other permissions are `playlists.public`, `library.scan` and `users.manage`, plus
  whatever plugins define. OpenSubsonic endpoints check the matching permission;
  per-user ones (stars, playlists, queues, bookmarks) also need an account.
- **Sessions** live in Redis:
  - `POST /api/noctis/v1/auth/login { username, password }` returns a token. Send it as
    `Authorization: Bearer <token>` on `/api/noctis`, and as `apiKey` on `/rest`.
  - Redis keeps only the token's hash, with a sliding expiry (`NOCTIS_SESSION_TTL_DAYS`).
  - Logging out ends one session; a password change or deleting the user ends them all.
- **Guest access**, for instances that don't want accounts: with
  `NOCTIS_GUEST_ACCESS=true`, requests without a token act as the guests group. Admins
  choose what guests may do by editing that group.
- **Legacy clients are dropped:**
  - `u`/`p` passwords and `t`/`s` md5 tokens on `/rest` are refused with error 42;
  - there's no JSONP.

  Only OpenSubsonic clients with API keys work.
- **Administration** needs `users.manage`:
  - `GET /api/noctis/v1/admin/users`, `POST` to create one, `PATCH /admin/users/:name` for
    groups or a password, `DELETE` to remove one;
  - `GET /admin/groups`, `PUT /admin/groups/:name { permissions, description }`,
    `DELETE`;
  - `GET /admin/permissions`.

  Admins can't remove themselves from `admins`, and built-in groups can't be deleted.

## Clients and servers agreeing on plugins

1. With every request to `/api`, a Noctis client says which plugins it
   runs (`x-noctis-plugins: play-stats@1.0.0,lyrics@2.3.1`) and which platform it is
   (`x-noctis-platform: android`).
2. `GET /api/noctis/v1/handshake` answers with:
   - the client plugins this server wants (`plugins`), each with its accepted
     `versions`, whether it's `required`, the SHA-256 of its `index.js`, and a
     `download` path;
   - what this client is missing or has in the wrong version (`result`), and which
     plugins don't run on its platform, so aren't required (`result.unsupported`).
3. If a client lacks a required plugin, other `/api` requests get **428
   Precondition Required** with the same handshake body. Turn this off with
   `NOCTIS_ENFORCE_CLIENT_PLUGINS=false`; a plugin's own routes always require its
   client half anyway. **`/rest` is never checked**, because OpenSubsonic clients
   can't negotiate plugins.
4. The client downloads the missing halves from
   `/api/noctis/v1/plugins/<id>/client.noctis`. Those archives contain the client half only,
   with `"side": "client"`, served as `application/x-noctis-plugin` so Android offers to
   open a downloaded one with Noctis. The client then:
   - checks each archive's `index.js` against the announced hash;
   - asks the user once;
   - installs and enables the plugins.

## API

| | |
| --- | --- |
| `/rest/<endpoint>` | OpenSubsonic: `ping`, `getLicense`, `getOpenSubsonicExtensions`, `getMusicFolders`, `getScanStatus`, `startScan`, `getUser`, `getArtists`, `getIndexes`, `getArtist`, `getAlbum`, `getSong`, `getMusicDirectory`, `getGenres`, `getTopSongs`, `getSimilarSongs2`, `getAlbumList(2)`, `getRandomSongs`, `getSongsByGenre`, `getStarred(2)`, `getNowPlaying`, `search2`, `search3`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `star`, `unstar`, `setRating`, `scrobble`, **`getPlayQueue`, `savePlayQueue`, `getPlayQueueByIndex`, `savePlayQueueByIndex`** (indexBasedQueue), **`getBookmarks`, `createBookmark`, `deleteBookmark`**, `stream` (plus Noctis's `source=`), `download`, `getCoverArt`, plus plugin endpoints. XML by default, or JSON with `f=json`; formPost accepted. |
| `GET /api/noctis/v1/info` | Name, versions, library size, guest access. |
| `GET /api/noctis/v1/handshake`, `/plugins`, `/plugins/:id/client.noctis` | Plugin negotiation. |
| `POST /api/noctis/v1/auth/login`, `/register`, `/logout`; `GET /api/noctis/v1/me` | Sessions. |
| `GET /api/noctis/v1/songs/:id/sources`, `POST /api/noctis/v1/sources` | "Play from": every source of one song, or of up to 200. |
| `GET /api/noctis/v1/recommendations` | `?seed=<song id>&limit=&context=` |
| `GET /api/noctis/v1/providers`, `GET`/`POST /api/noctis/v1/scan` | Providers; library scans. |
| `/api/noctis/v1/admin/…` | Users, groups, permissions. |
| `ANY /api/plugins/:id/*` | A plugin's own routes. |
| `GET /*` (anything else) | The browser client, when `NOCTIS_WEB_CLIENT` is on. A page it serves connects to this server by itself. |

CORS is open (`*`): there are no cookies, and credentials are tokens.

## Configuration

Settings come from environment variables; see `apps/server/.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOCTIS_NAME` | `Noctis` | Instance name |
| `NOCTIS_PORT`, `NOCTIS_HOST` | `4747`, `0.0.0.0` | Where to listen |
| `NOCTIS_DATABASE_URL` | `postgres://noctis:noctis@localhost:5432/noctis` | PostgreSQL |
| `NOCTIS_REDIS_URL` | `redis://localhost:6379` | Redis (sessions) |
| `NOCTIS_SESSION_TTL_DAYS` | `90` | Sessions expire after this long unused |
| `NOCTIS_DATA_DIR` | `./data` | Plugin cache, and plugins by default |
| `NOCTIS_PLUGINS_DIR` | `$NOCTIS_DATA_DIR/plugins` | Plugins to load |
| `NOCTIS_ADMIN_USER`, `NOCTIS_ADMIN_PASSWORD` | none | The admin created on first start |
| `NOCTIS_OPEN_REGISTRATION` | `false` | Anyone may create an account |
| `NOCTIS_GUEST_ACCESS` | `false` | Requests without a session act as the guests group |
| `NOCTIS_ENFORCE_CLIENT_PLUGINS` | `true` | Refuse Noctis clients missing required plugins |
| `NOCTIS_MAX_BODY_BYTES` | `1048576` | Largest request body |
| `NOCTIS_WEB_CLIENT` | `true` | Serve the browser client at `/` |
| `NOCTIS_WEB_CLIENT_DIR` | `apps/client/dist` | Which build to serve (run `bun run build:web` first) |
| `LOCAL_LIBRARY_DIRS` | none | The local-library plugin's first directories |

## Not there yet

- **No transcoding.** `maxBitRate` is passed to providers, but local files stream as
  they are.
- **No rate limiting.** A public instance should add it, in an `onRequest` hook or a
  reverse proxy.
- **No admin UI.** The admin API exists, but plugins can't be enabled, disabled or
  reloaded without a restart.
- **Recommendations and AI** are designed but not built: AI providers, job queue, song
  identity and the rate-limited HTTP layer ([RECOMMENDATIONS.md](RECOMMENDATIONS.md)).
- **Some OpenSubsonic parts are missing:** shares, podcasts, internet radio, lyrics.
  Plugins can add them as extensions.
