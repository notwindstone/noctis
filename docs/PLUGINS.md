# Plugins

Noctis plugins are JavaScript that change what the app shows or does: add a whole
streaming service, add buttons and settings, replace any screen or component, or
intercept requests. The design follows [Kaede](https://github.com/kaede-basement/kaede)'s
extension system.

> [!CAUTION]
> There is no sandbox yet. A plugin runs with full access to the app: it can change any
> screen, read your library and your signed-in accounts, and make network requests.
> Noctis asks before running new code, but only install plugins you trust.

The app ships with no plugins, and so with no services: everything it plays comes from
a plugin you install. Examples:

- [`examples/plugins/youtube-music`](../examples/plugins/youtube-music) — YouTube Music:
  home, search, library, sign-in and playback. Written in TypeScript with npm packages
  (youtubei.js, BotGuard); see [Building from source](#building-from-source);
- [`examples/plugins/liquid-glass`](../examples/plugins/liquid-glass) — a theme: an
  iOS-style skin with a Liquid Glass tab bar and mini player (replaces `BottomNav`) and
  CSS that repoints the Material colour roles at Apple's system colours. Glass from
  [@sohumsuthar/liquid-glass](https://www.npmjs.com/package/@sohumsuthar/liquid-glass)'s
  CSS and optics (its React components aren't used). For your own glass: no ancestor
  of a `backdrop-filter` may have `transform`, `will-change`, `contain`, `opacity`
  below 1, or a `mix-blend-mode` descendant in the same stacking context, or it blurs
  nothing;
- [`examples/plugins/spotify`](../examples/plugins/spotify) — a real service plugin:
  Spotify through the same GraphQL API its web player uses (session from a hidden web
  player, operation hashes read from its scripts), with audio matched on YouTube Music
  through `Noctis.api.request('youtube-music', …)`;
- [`examples/plugins/demo-source`](../examples/plugins/demo-source):
a fake "demo" streaming service with a hook, a song-menu action, a settings page and a
screen.

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
  side?: 'client' | 'server' | 'both' // default 'client'
  dependencies?: Record<string, string> // plugin id → semver range, e.g. { "youtube-music": "^1.0.0" }
  platforms?: string[] | '*' // where index.js runs: 'android', 'ios', 'web', 'desktop'; default ['*'] (everywhere)
}
```

`platforms` says which apps a plugin works in. The Spotify example lists `["android"]`
(it needs the app's hidden WebView); most plugins can leave it out, or say `"*"`.
Noctis refuses to install a plugin made for another platform, and a Noctis server doesn't
require one from clients it can't run on.

Plugins whose `dependencies` are missing or the wrong version don't start; the log on
their page says why. Plugins that run on the server, or on both sides, are covered in
[SERVER-PLUGINS.md](SERVER-PLUGINS.md). Installing a "both" plugin in the app installs
its client half.

Pack a folder with `bun run pack-plugin path/to/folder` (writes
`dist-plugins/<folder>.noctis`). Install it from **Settings → Plugins → Install from
file** or **Install from URL**. On Android, opening a `.noctis` file (from a file manager,
the browser's downloads or a chat app) offers Noctis, which installs it and asks before
running it. A copy named `my-plugin (1).noctis` still installs as `my-plugin`.

### Consent and code fingerprints

Enabled state is keyed by the SHA-256 of `index.js`. The first time a particular code is
enabled, Noctis asks; if the code changes — even under the same id — the plugin shows as
off until it's enabled (and approved) again.

**Settings → Plugins → Run plugins** switches every installed plugin off without
uninstalling them (safe mode).

### Building from source

A folder with `src/index.ts` instead of `index.js` is built by `pack-plugin` first: Vite
bundles its TypeScript, `.vue` files and npm packages into a single `index.js` that
calls the default export of `src/index.ts` with `scopedThis`. `vue` and
`@capacitor/core` aren't bundled; imports of them resolve to the app's own copies
(`Noctis.packages.vue` and `Noctis.packages.capacitor`). Reach the app itself through
`window.__NOCTIS__` (the same object as `scopedThis.Noctis`); `import type` from the
app's `apps/client/src/` is fine, since types are erased. See
[`examples/plugins/youtube-music/src/host.ts`](../examples/plugins/youtube-music/src/host.ts).

```sh
bun run pack-plugin examples/plugins/youtube-music   # dist-plugins/youtube-music.noctis
```

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
(no `library.playlists` → no "Your playlists"; no `account` → the service has no entry in Settings → Accounts).

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
| `account` | `{ signedIn, info, sessionKey, section?, signInTitle?, signInDescription?, refresh?(), signInMethods?, signOut?() }` |

The full types are in [`apps/client/src/services/types.ts`](../apps/client/src/services/types.ts) and
[`apps/client/src/models.ts`](../apps/client/src/models.ts). Use getters for live values (`get signedIn()`,
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

Accounts are managed in one place, **Settings → Accounts**: every service's account and
the connected server's. A service doesn't add its own sign-in buttons. It lists
`signInMethods` instead (`{ id, label, description?, icon?, hidden?, run() }`, main one
first) and a `signOut()`; Accounts shows them, asks before signing out, and links to the
service's `section` for its other settings. `Noctis.libs.accounts.registerAccount(id, { name,
account })` adds an account that isn't a service's (the server's, before you sign in).

Downloads fetch `contentLength` bytes in ranges from `fetchUrl ?? url` (with
`fetchHeaders` on a device); `blob:` and `data:` URLs work too.

`Noctis.libs.offline.download(song)` (also what the Download buttons call) puts the song in
the download queue and resolves when it's done or failed. The queue is saved, so a killed app
resumes it at the next start. How many songs run at once is the user's setting (Settings →
Storage); a service that throttles clients can lower that with `downloads: { concurrency,
minIntervalMs }` in its definition: at most `concurrency` of its songs at once, and at least
`minIntervalMs` between two starts.

The app shows one notification ("Downloading", "3 out of 12", a progress bar) instead of a
message per song. Tapping it opens the Downloading page (route `downloads-queue`, also under
Settings → Storage), where the user sees what is downloading and waiting, cancels one song or
all, and retries failures. `offline.cancelDownload(id)` and `cancelDownloads()` do the same from
code, and a Download button pressed while its song downloads cancels it.

### Notifications

`Noctis.libs.notifications` shows system notifications: Android's shade, the browser's
Notifications API (a desktop backend will join them).

```ts
const { notifications } = Noctis.libs
await notifications.show({
  id: 'my-sync',            // showing the same id again updates it
  title: 'Syncing 3 of 12',
  progress: 0.25,           // 0..1 is a bar; 'indeterminate' a busy one (a percentage in the browser's text)
  ongoing: true,            // can't be swiped away while work continues
  quiet: true,              // no sound or pop-up
  actions: [{ id: 'stop', label: 'Stop' }],   // buttons (Android)
  onlyInBackground: true,   // hidden while the app is in front, shown when it goes away
  onAction: (action) => { if (action === 'stop') cancel() },  // 'click' is the notification itself
})
notifications.update('my-sync', { progress: 0.5 })
notifications.close('my-sync')
```

`show` asks for permission the first time (Android 13+, browsers), so call it from something
the user did; it resolves `false` if notifications aren't allowed. `permission()` and
`requestPermission()` return `'granted' | 'denied' | 'prompt'`. Progress updates are
throttled to a few a second. A `body` with several lines shows its first line collapsed and all
of them when expanded on Android. Downloads use this for their progress.

### Signing in with OAuth

`Noctis.libs.auth.openAuthWindow({ url, redirect, title })` opens an authorization page
and resolves with the URL it redirected to, so a plugin can read `?code=` and finish a
PKCE flow with `fetch`. On a device a sign-in screen catches the redirect before loading
it, so any redirect URI works. In the browser (development) a popup ends on
`/auth-callback.html`, so use `http://127.0.0.1:5199/auth-callback.html` (open the dev
server at that address too). 

Three more helpers for services without a public API:

- `Noctis.libs.auth.openCookieLogin({ url, cookieUrl, cookie, title })` opens a site's
  own sign-in page and resolves with the value of the cookie `cookie` on `cookieUrl` as
  soon as the site sets it, with every cookie on `cookieUrl` (`{ value, cookies }`;
  httpOnly ones too, where refresh tokens live). That suits sites whose session is a cookie, and whose
  single-page sign-in never redirects anywhere a redirect URI could catch. The SoundCloud
  plugin reads `oauth_token` this way. Device only; in a browser, ask for the value
  instead.

- `Noctis.libs.auth.captureWebResponse({ url, match })` loads `url` in a hidden WebView
  and resolves with `{ url, body }` of the first response whose URL contains `match`, so
  a site's own code can do its session handshake (the Spotify plugin reads the web
  player's token this way). It shares cookies with `openAuthWindow`, so signing in there
  carries over; `clearSiteCookies(url)` signs one site out. Device only (`canCaptureWeb`).
- `Noctis.libs.http.request(url, { method, headers, body })` makes a request without
  CORS (native HTTP on a device) and resolves with `{ status, headers, data }`, `data`
  parsed when it's JSON.

The Spotify and SoundCloud plugins show them.

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

## Play from

`Noctis.libs.playFrom` decides where a song's audio comes from. A plugin can add options
for any song, such as another service that has it. They show up in the Play from dialog,
which is the same from Settings → Playback and from the player's menu:

```js
const unregister = Noctis.libs.playFrom.registerPlaybackOptions(async (song) => {
  const match = await findOnMyService(song.title, song.artists)
  if (!match) return []
  return [{
    id: `my-service:${match.id}`,
    label: 'My service',
    description: 'FLAC',
    available: true,
    target: 'own:my-service', // lets "All songs → Always My service" pick it
    group: 'own', // listed under "Yours"; 'server' for a server's streams
    resolve: async (efficient) => ({ url: match.url, mimeType: 'audio/flac', bitrate: 900_000, expiresAt: Date.now() + 3_600_000 }),
  }]
})
Plugin.subscribe('lifecycle::disable', unregister)
```

A target is the same for every song: `device`, `server:<provider>` (the server's copy
from one provider) or `own:<service>`. The preference for all songs is a mode
(`'auto' | 'server' | 'own'`) or one target. Songs without that target play as `'auto'`.
Services with `streams` are targets automatically. Add others with
`registerPlaybackTargets(() => [{ id, label, group, available, description }])`, where
`available: false` shows the target greyed out with `description` saying why.

Other helpers there:
- `playbackOptions(song)`, `pickOption(song, options)` (which one would play);
- `chooseOption(song, id)` (`null` follows the preference again), `chosenOption(song)`;
- `playbackPreference` (a ref) and `playbackTargets()`;
- `showPlayFrom({ song })` in `Noctis.libs.ui` opens the dialog. The dialog is
  `C.PlayFromDialog`, so a plugin can replace it.

When a song's own source can't play it (a server that only knows it from MusicBrainz,
a stream a service refuses), the player tries the song's other available options: this
device first, then yours, then a server's (`resolveFallback`).

### Finding a song on your service

`Noctis.libs.matching` lets a service play songs from elsewhere by searching for them.
One call is enough:

```js
const stop = Noctis.libs.matching.offerAsSource('soundcloud', {
  minScore: 0.7, // 0..1, from title, artists and length
  skip: ['spotify'], // sources that match on their own
  accept: (song) => !isPreview(song), // which of your songs may stand in for another
})
Plugin.subscribe('lifecycle::disable', stop)
```

Every song from another source then gets a "Play from" option on this service. It's
found by searching when it's first needed and remembered on the device. It isn't offered
when the song already has this service as a source (say, the server's YouTube Music
copy).
- **Rejected matches:** lengths far apart (an hour-long loop), and uploads that alter the
  song ("bass boosted", "slowed", "cover", "remix", "live"…) unless the wanted title says
  so too.
- **Helpers:** `matchScore(wanted, candidate)` and `candidatesOn(service, song)` are there
  for plugins that match their own way.

The YouTube Music and SoundCloud plugins both offer themselves.

`Noctis.libs.local` is the device's music: `localTracks`, `scanLocalLibrary()`,
`addLocalFolder()` (an extra folder), `requestMusicAccess()` (Android: the
whole-device scan) and `findLocalMatch(title, artists)`. `Noctis.libs.server` is the
connection to a Noctis server; its `serverRequest(path, init)` sends the session and
the plugin header.

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
| Sheets and player parts | `BottomSheet`, `DialogShell`, `QueuePanel`, `SeekBar` |
| Building blocks | `TopAppBar`, `ItemRow`, `ItemCard`, `SectionView`, `SettingsRow`, `SettingsBlocks`, `CollectionView`, `StateView`, `RefreshIndicator`, `MIcon`, `Thumb` |
| Screens | `HomeScreen`, `LibraryScreen`, `SettingsScreen`, `SearchScreen`, `AlbumScreen`, `PlaylistScreen`, `ArtistScreen`, `BrowseScreen`, `CollectionScreen`, `LibraryItemsScreen`, `SettingsPageScreen` |

Every component the app uses goes through the registry, down to icons (`MIcon`) and
artwork (`Thumb`), so a theme plugin can restyle all of it. Use them from `Noctis.C` in
your own components too (`h(Noctis.C.MIcon, { name: 'music' })`), so they follow
whatever replaced them. The only exceptions are the small widgets inside built-in
settings pages (About, colour swatches, storage meter, plugin log).

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
| `libs` | `auth`, `player`, `navigation`, `library`, `offline`, `notifications`, `session`, `ui`, `snackbar`, `theme`, `preferences`, `http`, `stream`, `models`, `thumbnails`, `haptics`, `back` |
