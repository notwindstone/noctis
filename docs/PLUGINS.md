# Plugins

Noctis plugins are JavaScript that change what the app shows or does: add a whole
streaming service, add buttons and settings, replace any screen or component, or
intercept requests. The design follows [Kaede](https://github.com/kaede-basement/kaede)'s
extension system.

> [!CAUTION]
> There is no sandbox yet. A plugin runs with full access to the app: it can change any
> screen, read your library and your signed-in accounts, and make network requests.
> Noctis asks before running new code, but only install plugins you trust.

Examples:

- [`examples/plugins/spotify`](../examples/plugins/spotify) — a real service plugin:
  Spotify through the same GraphQL API its web player uses (session from a hidden web
  player, operation hashes read from its scripts), with audio matched on YouTube Music
  through `Noctis.api.request('youtube-music', …)`;
- [`examples/plugins/demo-source`](../examples/plugins/demo-source):
a fake "demo" streaming service with a hook, a song-menu action, a settings page and a
screen. **YouTube Music itself is a plugin**: [`src/services/youtube-music`](../src/services/youtube-music)
ships with the app and plugs in the same way (see [Bundled plugins](#bundled-plugins)).

## Format

A plugin is a ZIP archive with a `.noctis` or `.zip` extension containing:

- `index.js` — the code;
- `metadata.json` — the description below.

Both may sit at the archive root or inside one top-level folder. **The archive's file
name (minus the extension) is the plugin id**, so `lyrics.noctis` installs as `lyrics`.

```ts
type Metadata = {
  name: string
  type: 'unrestricted' // the only type for now
  version?: string
  authors?: string[]
  description?: string
  logo?: string // https: or data:image/ URL
  source?: string // e.g. the repository
  categories?: string[]
  languages?: string[] // ISO 639-1
}
```

Pack a folder with `npm run pack-plugin -- path/to/folder` (writes
`dist-plugins/<folder>.noctis`). Install it from **Settings → Plugins → Install from
file** or **Install from URL**.

### Consent and code fingerprints

Enabled state is keyed by the SHA-256 of `index.js`. The first time a particular code is
enabled, Noctis asks; if the code changes — even under the same id — the plugin shows as
off until it's enabled (and approved) again.

**Settings → Plugins → Run plugins** switches every installed plugin off without
uninstalling them (safe mode).

### Bundled plugins

Plugins listed in [`src/plugins/bundled.ts`](../src/plugins/bundled.ts) ship with the
app: YouTube Music, for now. They're built with the app (so they can import npm
packages — YouTube Music uses youtubei.js and BotGuard — and load as their own chunk),
then run through the same runtime and lifecycle as installed plugins, receiving the
same `scopedThis`. Differences: they're on by default, need no consent, can't be
removed, and keep running when **Run plugins** is off. Turn one off on its page in
Settings → Plugins.

## How code runs

`index.js` is the body of an `async` function (top-level `await` works) executed in the
app's own context. It receives one argument, `scopedThis`:

| Name | What it is |
| --- | --- |
| `scopedThis.Plugin` | This plugin's API: events, registries attributed to it, log, storage |
| `scopedThis.Noctis` | `window.__NOCTIS__`: registries, hooks, the app's libraries and Vue |

```js
const { Plugin, Noctis } = scopedThis
const { h, ref, computed } = Noctis.packages.vue // the app's own Vue

Plugin.log('Hello from my plugin')
```

### Lifecycle

| When | What runs |
| --- | --- |
| First enable in a session (or app start) | The whole `index.js` |
| Disable | `lifecycle::disable` callbacks (`::before`, then `::after`) |
| Enable again in the same session | `lifecycle::dirty-enable` — the code is **not** re-run |

Disabling only runs your callbacks. Undoing what you added — unsubscribing hooks,
removing entries, restoring components, removing settings — is the plugin's job:

```js
function attach() { /* subscribe, register, push entries */ }
function detach() { /* the reverse */ }

Plugin.subscribe('lifecycle::disable', detach)
Plugin.subscribe('lifecycle::dirty-enable', attach)
attach()
```

## `Plugin`

```ts
Plugin.subscribe(event, callback): Plugin      // chainable
Plugin.unsubscribe(event, callback): Plugin
```

`event` is one of:

| Event | Callback receives |
| --- | --- |
| `'hook::<name>::<before\|after>'` | the hook's context (see [Hooks](#hooks)) |
| `'hook::<name>::<before\|after>::start'` | same, but runs before other plugins' hooks |
| `'lifecycle::dirty-enable'` | the plugin id |
| `'lifecycle::disable'` / `'lifecycle::disable::after'` | the plugin id |
| a getter function, e.g. `() => Noctis.libs.player.currentSong.value` | the new value, whenever it changes |

Also on `Plugin`:

- `log(...)`, `warn(...)`, `error(...)` — written to the plugin's log (its page in
  Settings → Plugins) and the console;
- `registerComponent(name, component)`, `restoreComponent(name)`;
- `registerAction(id, action)`, `unregisterAction(id)`;
- `defineService(id, service)`, `removeService(id)` (see [Services](#services));
- `defineSection(section, blocks, position?)`, `removeSection(id)`;
- `storage.get(key, fallback?)`, `storage.set(key, value)`, `storage.remove(key)` —
  small JSON values kept on the device.

Registrations made through `Plugin` are attributed to the plugin. When something
replaces a service, component, action or settings section another plugin (or the app) provided,
the last registration wins and a **warning naming both** is logged.

## Services

Everything Noctis shows comes from a **service**: an object of endpoints grouped by area,
defined under an id. The app decides which service to ask and handles the rest —
screens, paging, the queue, caching, downloads, likes and history work the same for
every service.

```js
Plugin.defineService('spotify', {
  name: 'Spotify',
  icon: 'music',
  search: {
    filters: [{ id: 'song', label: 'Songs' }, { id: 'album', label: 'Albums' }],
    async query({ query, type }) { return { sections: [/* … */], items: [], hasMore: false } },
    async suggestions({ input }) { return { queries: [], items: [] } },
  },
  albums: { async get({ id }) { /* … */ } },
  streams: { async resolve({ song, efficient }) { return { url, mimeType, bitrate, expiresAt } } },
})
```

Every endpoint takes **one input object** and returns a promise. Only `name` is
required; leave out what a service can't do and the app hides or disables what needs it
(no `library.playlists` → no "Your playlists"; no `account` → no account card).

| Area | Endpoints (input → result) |
| --- | --- |
| `home` | `load({ filter })` → `{ sections, filters, selectedFilter, hasMore }`; `more({ filter })` → `{ sections, hasMore }` |
| `search` | `filters: [{ id, label }]`; `query({ query, type })` → `{ sections, items, hasMore, correctedQuery? }` ("all" fills `sections`, a filter fills `items`); `more({ query, type })` → `{ items, hasMore }`; `suggestions({ input })` → `{ queries, items }` |
| `albums` | `get({ id })` → collection page `{ id, kind, title, artists, songs, hasMore, sections, playlistId?, … }` |
| `playlists` | `get({ id })` → collection page; `more({ id })` → `{ songs, hasMore }` |
| `artists` | `get({ id })` → `{ id, name, sections, thumbnail?, shuffle?, radio?, … }` |
| `browse` | `get({ target })` → `{ title, sections }` (a section's "More") |
| `queue` | `start({ playlistId?, videoId?, params? })`, `more({ continuation, playlistId? })`, `radio(seed)` → `{ songs, continuation?, playlistId? }`; `seed` is `{ kind: 'song', song }`, `{ kind: 'album', album, playlistId? }` or `{ kind: 'playlist', playlist }` |
| `library` | `playlists({})`, `artists({})`, `liked({})` / `likedMore({})` → `{ songs, hasMore }`, `like({ song, liked })` |
| `streams` | `resolve({ song, efficient })` → `{ url, mimeType, bitrate, expiresAt, contentLength?, loudnessDb?, fetchUrl?, fetchHeaders? }` |
| `links` | `share(item)` → URL or `undefined` — **synchronous** |
| `thumbnails` | `resize(url, px)` → URL or `undefined` if it isn't yours — **synchronous**, runs while rendering |
| `account` | `{ signedIn, info, sessionKey, section?, signInTitle?, signInDescription?, refresh?() }` |

The full types are in [`src/services/types.ts`](../src/services/types.ts) and
[`src/models.ts`](../src/models.ts). Use getters for live values (`get signedIn()`,
even `get library()` to offer library endpoints only when signed in, as YouTube Music
does) — as with settings rows, nothing needs rebuilding.

**Which service answers:**

- calls about an item — its page, stream, radio, like, share link — go to the item's
  **`source`**. Set `source: '<your id>'` on every song, album, playlist and artist you
  return, and prefix ids with it (`spotify:4uLU6hMC…`) so they never collide with other
  services' ids in likes, downloads or the queue. Items without `source` are YouTube
  Music's. A section's `more` target carries `source` too;
- home, search and the account library go to the **active service**, picked in
  **Settings → Content → Service** (`Noctis.activeServiceId`).

`account.sessionKey` should change whenever content would come out different (another
account, region…): screens refetch and cached pages are dropped when it changes.

Downloads fetch `contentLength` bytes in ranges from `fetchUrl ?? url` (with
`fetchHeaders` on a device); `blob:` and `data:` URLs work too.

### Signing in with OAuth

`Noctis.libs.auth.openAuthWindow({ url, redirect, title })` opens an authorization page
and resolves with the URL it redirected to, so a plugin can read `?code=` and finish a
PKCE flow with `fetch`. On a device a sign-in screen catches the redirect before loading
it, so any redirect URI works. In the browser (development) a popup ends on
`/auth-callback.html`, so use `http://127.0.0.1:5199/auth-callback.html` (open the dev
server at that address too). 

Two more helpers for services without a public API:

- `Noctis.libs.auth.captureWebResponse({ url, match })` loads `url` in a hidden WebView
  and resolves with `{ url, body }` of the first response whose URL contains `match`, so
  a site's own code can do its session handshake (the Spotify plugin reads the web
  player's token this way). It shares cookies with `openAuthWindow`, so signing in there
  carries over; `clearSiteCookies(url)` signs one site out. Device only (`canCaptureWeb`).
- `Noctis.libs.http.request(url, { method, headers, body })` makes a request without
  CORS (native HTTP on a device) and resolves with `{ status, headers, data }`, `data`
  parsed when it's JSON.

The Spotify plugin shows both.

Other plugins can call any service through the same API:

```js
const { api } = Noctis
await api.request('youtube-music', 'search.query', { query: 'Daft Punk Voyager', type: 'song' })
await api.getAlbum(id, 'spotify')
```

## Hooks

Hooks intercept named points in the app, Kaede-style. There are only two: services do
the rest.

| Hook | `before` receives | `after` receives |
| --- | --- | --- |
| `onRequest` | `{ service, endpoint, input }` for **every** service call (`endpoint` is `'albums.get'`, `'streams.resolve'`, …) | `{ service, endpoint, input, result }` |
| `onPlay` | `{ song, index }` before a song loads — `stop` skips it | `{ song, index }` once it plays |

- a **`before`** hook may change what it receives — for `onRequest`, rerouting the call
  to another `service`, or rewriting `input`. Returning `{ status: 'stop', response }`
  skips the call and every later hook; `response` becomes the result;
- an **`after`** hook may change `result`, or return `{ status: 'stop', response }` to
  replace it;
- returning nothing (or `{ status: 'continue' }`) carries on. A hook that throws is
  logged and skipped.

```js
// Hide videos from every search result, whichever service answered.
Plugin.subscribe('hook::onRequest::after', (request) => {
  if (request.endpoint !== 'search.query') return
  for (const section of request.result.sections) section.items = section.items.filter((item) => !item.isVideo)
})

// Play Spotify songs with audio found on YouTube Music.
Plugin.subscribe('hook::onRequest::before', async (request) => {
  if (request.endpoint !== 'streams.resolve' || request.input.song.source !== 'spotify') return
  const match = await findOnYouTubeMusic(request.input.song)
  return { status: 'stop', response: await Noctis.api.request('youtube-music', 'streams.resolve', { ...request.input, song: match }) }
})
```

## Component registry

The app renders its UI through `Noctis.C`, a reactive record — replacing an entry swaps
it everywhere, live:

```js
Plugin.registerComponent('BottomNav', MyBottomNav)
// later, on disable:
Plugin.restoreComponent('BottomNav')
```

| Group | Entries |
| --- | --- |
| App shell | `ScreenStack`, `PlayerSheet`, `BottomNav`, `SheetHost`, `SnackbarHost` |
| Building blocks | `TopAppBar`, `ItemRow`, `ItemCard`, `SectionView`, `SettingsRow` |
| Screens | `HomeScreen`, `LibraryScreen`, `SettingsScreen`, `SearchScreen`, `AlbumScreen`, `PlaylistScreen`, `ArtistScreen`, `BrowseScreen`, `CollectionScreen`, `LibraryItemsScreen`, `SettingsPageScreen` |

A name that isn't built in adds a new component. Screens receive `route`, `screenKey`
and `isRoot` props; a registered screen opens with
`Noctis.libs.navigation.navigate({ name: 'MyScreen' })` and gets the app's transitions
and predictive back for free. There's no template compiler at runtime — write components
with `h()` (render functions) or ship pre-compiled ones.

## Actions and action collections

Buttons are data: entries in an **action collection** point to an **action** by id.

```js
Plugin.registerAction('lyrics.show', async ({ item, handlers }) => {
  handlers.pending()
  // …
  handlers.success('Lyrics copied') // or handlers.error('Not found'), handlers.reset()
})

Noctis.ActionCollections.songMenu.push({
  id: 'lyrics',
  icon: 'lyrics',
  label: 'Show lyrics',
  action: 'lyrics.show',
  visible: ({ item }) => !item.isVideo,
})
```

Entry fields: `id`, `icon` and `label` (values or functions of the context), `action`,
and optional `visible`, `disabled`, `filled` and `progress` (0..1 shows a progress ring)
functions. Returning `false` from an action (or throwing) reports a failure.

| Collection | Context |
| --- | --- |
| `songMenu` | `{ item: Song, list?, queueIndex? }` |
| `albumMenu` | `{ item: Album }` |
| `playlistMenu` | `{ item: Playlist }` |
| `artistMenu` | `{ item: Artist }` |
| `playerActions` (chips under the player) | `{ song: Song }` |

Re-registering an existing action id (e.g. `song.download`) changes what that button
does everywhere. `Noctis.defineCollection(name)` creates a collection for your own UI.

Icons are [Material Symbols](https://fonts.google.com/icons) names the app ships, or ones
you add: `Noctis.registerIcon(name, outlinedPath, filledPath?)` with SVG path data in the
`0 -960 960 960` viewBox.

## Settings

Settings pages are data in `Noctis.Rows`, keyed by section id. Rows are plain objects
whose live fields are **getters** — no `computed`, nothing reallocated:

```js
const enabled = Noctis.packages.vue.ref(Plugin.storage.get('enabled', true))

Plugin.defineSection({ id: 'my-plugin', icon: 'plugin', title: 'My plugin' }, [
  Noctis.group('main', [
    {
      id: 'enabled',
      title: 'Do the thing',
      get description() { return enabled.value ? 'On' : 'Off' },
      toggle: {
        get value() { return enabled.value },
        set(value) { enabled.value = value; Plugin.storage.set('enabled', value) },
      },
    },
    {
      id: 'mode',
      title: 'Mode',
      select: {
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        get value() { return mode.value },
        set(value) { mode.value = value },
      },
    },
  ]),
  { id: 'note', type: 'note', text: 'Shown under the rows.' },
])
```

The section appears in Settings (before About) with the app's own rows, switches and
choice dialogs. Row fields: `id`, `title`, `icon`, `description`, `value`, `chevron`,
`destructive`, `disabled`, `hidden`, `onClick`, `toggle` (`{ value, set }`) and
`select` (`{ title?, options, value, set }`). Blocks are `group` (rows), `header`,
`note`, or `component` (`{ component, props }`). Built-in sections (`appearance`,
`playback`, `content`, `storage`, `about`, …) are in the same record — plugins can push
rows into them.

## `window.__NOCTIS__`

| Field | |
| --- | --- |
| `packages.vue` | The app's Vue |
| `C`, `registerComponent`, `restoreComponent` | Component registry |
| `Actions`, `ActionCollections`, `registerAction`, `executeAction`, `defineCollection` | Actions |
| `Rows`, `Sections`, `defineSection`, `removeSection`, `group` | Settings |
| `services`, `defineService`, `removeService`, `activeService`, `activeServiceId` | Services |
| `api` | `request(service, endpoint, input)` and the helpers screens use (`getAlbum`, `search`, `radio`, …) |
| `hooks`, `hookNames`, `withHooks` | Hooks |
| `icons`, `registerIcon` | Icons |
| `log`, `writeLog` | The plugin log |
| `libs` | `auth`, `player`, `navigation`, `library`, `offline`, `session`, `ui`, `snackbar`, `theme`, `preferences`, `http`, `stream`, `models`, `thumbnails`, `haptics`, `back` |
