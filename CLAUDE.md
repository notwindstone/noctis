# Noctis

A music client and server reshaped by plugins. Start with [docs/VISION.md](docs/VISION.md);
plugin APIs are in [docs/PLUGINS.md](docs/PLUGINS.md) (client) and
[docs/SERVER-PLUGINS.md](docs/SERVER-PLUGINS.md) (server); the recommendations/AI design
(not built yet) is in [docs/RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md).

## Stack

| Part | Stack | Where |
| --- | --- | --- |
| Monorepo | Bun 1.4 workspaces (`bun install`, `bun.lock`; no npm lockfile) | `package.json` |
| Client UI | Vue 3.5 + TypeScript 6 (vue-tsc), Vite 8, Material Symbols icons; plain CSS (`src/styles/main.css`), no UI framework | `apps/client` |
| Android | Capacitor 8 (minSdk 24, target/compile 36), Java in `NoctisPlugin.java` (predictive back, media session, login WebViews, local music via MediaStore + SAF) | `apps/client/android` |
| Browser | The same Vite build (`bun run build:web` → `apps/client/dist`, relative paths). Served by Noctis servers at `/` (`NOCTIS_WEB_CLIENT`, `apps/server/src/web.ts`; the page auto-connects to its server) or from any static host. YouTube/Spotify plugins need a CORS proxy in browsers (Vite dev proxy in development; a CORS extension otherwise) — deliberately not solved | `apps/client` |
| Desktop | Tauri 2 shell around the same Vite build (`bun run dev:desktop`, `bun run build:desktop`; Windows from Linux with `cargo-xwin`, `--target x86_64-pc-windows-msvc` — the MinGW target needs a loose `WebView2Loader.dll` and crashes without it). Requests go through `plugin-http` (`Noctis.libs.http.nativeFetch`/`request`): no CORS, any header. Sign-in windows (`auth.rs`), system notifications, single instance, `window.__TAURI__` for plugins (as in Kaede). Launch options (`launch.rs`; `--help` lists them): `--no-plugins`, `--new-window` (another window of the same profile, no hand-over), `--data-dir <path>` (a profile of its own, so no hand-over either); a `portable.txt` or `data/` next to the exe keeps all data there (path from the exe, not the working directory). `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` are never overridden (Explorer dialogs read them); only `WEBVIEW2_USER_DATA_FOLDER` is set. Everything Noctis stores goes under the data directory: plugin-http is built without its `cookies` feature (it kept `.cookies` in `%LOCALAPPDATA%`), and downloads/cache are plain files in `<data>/music/{downloads,cache}` (`files.rs`; Settings → Storage → "Save as regular files"). Plugins get no file access of their own. "Lock screen controls" off on Windows starts the webview without its media-session features (`media.rs`, flag file, applied after a restart; sign-in windows must use the same browser args) and registers the media keys as global shortcuts instead. Windows ≥ 840px wide gets a navigation rail, centred content and a docked mini player (CSS in `main.css`, geometry in `PlayerSheet.vue`). Linux needs webkit2gtk-4.1 + libsoup dev packages. Not done yet: local music folders, tray, auto-update | `apps/client/src-tauri` |
| iOS | Capacitor 8 built with **xtool** (SwiftPM from Linux, no Xcode project): `bun run ios` / `ios:build` in `apps/client`. Swift port of the `Noctis` plugin (`NoctisPlugin.swift`, `WebSignIn.swift`, `LocalMusic.swift`); local music is picked folders only, back is the web edge swipe (`platform === 'android'` gates predictive back and the MediaStore scan). **Written without a Swift toolchain, never compiled or run** | `apps/client/ios` |
| Server | Bun + **Elysia 2.0.0-rc.0** (pinned), PostgreSQL 18 via `Bun.SQL`, Redis 8 via `Bun.RedisClient` (sessions), music-metadata in the local-library plugin | `apps/server` |
| Shared plugin system | Plain TypeScript (no Vue/Bun APIs), fflate for archives | `packages/plugin-core` |
| Example plugins | YouTube Music (youtubei.js 18, bgutils-js 4), Spotify, SoundCloud (web app API, HLS joined into one file), Monochrome (community API instances, FLAC), Liquid Glass (@sohumsuthar/liquid-glass CSS + optics), Lyrics (LRCLIB, NetEase, QQ, Musixmatch, Genius; replaces `PlayerArt`), local-library and MusicBrainz (server), play-stats (both) | `examples/plugins` |
| Dev services | `docker compose up -d` (PostgreSQL + Redis); Nix devshell in `flake.nix` | root |

## Commands

```sh
bun install
bun run dev                 # client at :5173
bun run dev:server          # server at :4747 (needs PostgreSQL + Redis)
bun run typecheck           # every workspace
bun test                    # plugin-core + server; needs NOCTIS_TEST_DATABASE_URL / NOCTIS_TEST_REDIS_URL
bun run pack-plugin examples/plugins/<name>     # → dist-plugins/<name>.noctis
bun run dev:desktop         # Tauri window around the dev server (needs Rust + system webview libs)
bun run build:desktop       # installers in apps/client/src-tauri/target/release/bundle
bun run --cwd apps/client ios   # build + sign + install on a USB iPhone with xtool (see apps/client/ios/README.md)
# Android APK:
cd apps/client && bunx vite build && bunx cap sync android && cd android && ./gradlew assembleDebug --offline
```

## Conventions

- Code reads like its surroundings: getter-based settings rows, registries plugins extend
  (components `C`, actions, settings sections, services, hooks), comments that explain why.
- The client renders everything through the component registry so plugins can replace it.
- The server's OpenSubsonic API (`/rest`) accepts API keys only; Noctis endpoints live
  under `/api/noctis/v1`, plugin routes under `/api/plugins/<id>`.
- System notifications go through `Noctis.libs.notifications` (`apps/client/src/notifications.ts`):
  Android shade or the Notifications API, never `new Notification` directly. Downloads run through
  the queue in `offline.ts`; don't download songs by hand.
- Server plugins are trusted code installed from disk only; client plugins need consent.
- No copyrighted audio in tests or demos: generate tones (see `apps/server/test/helpers.ts`).

## Pitfalls

- **Elysia 2:** routes take `(path, hook, handler)`; the 1.x order throws.
- **Bun.SQL:** JS strings are sent as JSON, so `${JSON.stringify(x)}::jsonb` double-encodes —
  use `(${JSON.stringify(x)}::text)::jsonb`. Bind arrays with `sql.array(list, 'text')`;
  `IN ${sql(list)}` for lists. Read BIGINT columns as `::float8`. The jsonb `?` operator
  doesn't work inside templates.
- **CSS class names are global:** prefix a screen's classes (`downloads-*`). A bare `queue-row` already
  belongs to the player's queue panel and restyled it when a new page reused the name.
- **Glass CSS:** `backdrop-filter` silently does nothing under an ancestor with
  transform/will-change/contain, or with a mix-blend-mode sibling in the same stacking
  context; round the blur layer itself.
- **Android:** services may reject the default `Dalvik/…` user agent (Spotify 403s);
  `content://` audio plays through `Capacitor.convertFileSrc`.
- **Headless tests:** storing a private-file-system handle in IndexedDB crashes headless
  Chromium; editing files while Vite runs creates `?t=` module copies, so drive tests
  through `window.__NOCTIS__` rather than dynamic imports.
