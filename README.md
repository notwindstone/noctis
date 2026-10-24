# Noctis

A music client and server you can reshape with plugins. Why, and where it's going:
[docs/VISION.md](docs/VISION.md).

- **Client** (`apps/client`): a Material You app built with **Vue 3.5** and
  **Capacitor 8**, in the spirit of InnerTune / ArchiveTune. Music comes from plugins:
  the app ships with none, and YouTube Music is one you install.
- **Server** (`apps/server`): **Bun** + **Elysia 2**, extended with server plugins.
  Like a modded Minecraft server, it can require clients to have matching plugins.
- **Plugin core** (`packages/plugin-core`): the plugin system both share.

The client:

- **Home**: search bar on top, mood chips, and YouTube Music's own home rows (Quick picks,
  "Similar to …", mixes, your playlists when signed in) with infinite scroll. Signed out,
  on-device "Listen again" and downloads rows are added.
- **Library**: liked songs, downloads, cached songs, recently played, your playlists and
  your artists (from your account, or derived from local listening when signed out).
- **Settings**: a list of rows, each opening its own screen: Account, Appearance,
  Playback, Content, Storage, About.
- **Player**: one surface that morphs between a floating mini player (cover, title,
  artist, prev/play/next) and the full player. Drag it up or down, or swipe the mini player
  sideways to skip. It has a queue with drag-to-reorder, and colours from the artwork.
- **Predictive back**: on Android 14+ the back gesture's progress drives the transition
  (the screen shrinks into a card and reveals the previous one; the player gets pulled
  down). Releasing commits it, and swiping back cancels it.

## Quick start

```sh
nix develop
bun install
bun run dev                                       # client: http://localhost:5173
bun run pack-plugin examples/plugins/youtube-music
```

Then install `dist-plugins/youtube-music.noctis` from **Settings → Plugins → Install from
file**.

The server, with the example plugin that needs both sides:

```sh
bun run pack-plugin examples/plugins/play-stats
mkdir -p apps/server/data/plugins && cp dist-plugins/play-stats.noctis apps/server/data/plugins/
bun run dev:server                                # http://localhost:4747
```

In the client, **Settings → Server → localhost:4747** connects, and offers to install the
plugin the server requires. `bun test` runs the plugin core's and the server's tests.

In the browser, InnerTune requests go through a small proxy in `vite.config.ts` (CORS,
and Cookie/Origin headers browsers refuse to send). Dragging in from the left or right
screen edge simulates the Android back gesture, so predictive back works there too.

### Android

```sh
bun run sync                                   # build + cap sync
cd apps/client/android
export ANDROID_HOME=$HOME/Android/Sdk
steam-run ./gradlew assembleDebug              # NixOS: gradle's binaries need an FHS env
```

## How it fits together

| Path | |
| --- | --- |
| `packages/plugin-core/` | shared by client and server: manifests (`side`, dependencies, client requirements), archives, semver, load order, the hook engine, `PluginBase`, client–server negotiation |
| `apps/server/src/plugins/` | server plugins: loading, `Plugin.routes()`, SQLite storage (see [docs/SERVER-PLUGINS.md](docs/SERVER-PLUGINS.md)) |
| `apps/server/src/app.ts` | the HTTP API: info, handshake, plugin downloads, plugin routes, client-plugin enforcement |

Client paths below are in `apps/client/`.

| Path | |
| --- | --- |
| `src/server.ts`, `src/settings/server.ts` | connecting to a server, and installing the plugins it requires |
| `src/models.ts` | plain models every screen uses (songs, albums, sections, pages…) |
| `src/services/` | the service layer: `types.ts` (what a service provides), `registry.ts`, `api.ts` (routes every call to the item's or the active service, through the `onRequest` hook) |
| `examples/plugins/youtube-music/` | YouTube Music, as a plugin built from TypeScript: youtubei.js sessions and sign-in (`client.ts`), native/proxied fetch (`http.ts`), endpoints (`api.ts`, `parse.ts`), streams with BotGuard tokens (`stream.ts`, `potoken.ts`) |
| `src/plugins/` | the client's side of the plugin system: runtime, hooks, component/action registries, settings rows (see [docs/PLUGINS.md](docs/PLUGINS.md)) |
| `src/player.ts` | queue, shuffle/repeat, radio autoplay, offline-first sources, persisted queue |
| `src/offline.ts` | downloads and the auto-trimmed cache (1 MB ranged chunks → app storage / Cache Storage) |
| `src/library.ts` | on-device likes (mirrored to the service when it takes them), history, search history |
| `src/back.ts` | single back-handling stack: native predictive back, browser back, Escape, edge swipe |
| `src/navigation.ts`, `components/ScreenStack.vue` | per-tab screen stacks; every screen is a layer, so back gestures can reveal the real previous screen |
| `src/theme.ts` | OKLCH Material 3 schemes from wallpaper (Android 12+), album art or a preset |
| `android/.../NoctisPlugin.java` | predictive back events, system accent colour, Google sign-in, cookie clearing |
| `android/.../LoginActivity.java` | WebView sign-in at accounts.google.com; returns music.youtube.com cookies |

## Streaming

googlevideo serves only the first ~1 MB of a stream unless the URL carries a
proof-of-origin (`pot`) token. `examples/plugins/youtube-music/src/potoken.ts` mints one per video the way
InnerTune-style clients do: it loads Google's BotGuard challenge (from
`jnn-pa.googleapis.com`), runs it in the page (the app is a real Chromium WebView), and
exchanges the snapshot for an integrity token at `youtube.com/api/jnn/v1/GenerateIT`.
`examples/plugins/youtube-music/src/stream.ts` then uses the YouTube Music web client, deciphers the URL with the
player script, and appends `&pot=`. BotGuard and the player script are pre-warmed shortly
after launch.

Headless/automated browsers get a fallback token only (no integrity token). Run tests
with `--disable-blink-features=AutomationControlled`.

## Known gaps

- No native media service: no lock-screen/notification controls, and Android may stop
  background playback when it reclaims the process.
- Library pages (playlists/artists) load up to 6 continuation pages.
