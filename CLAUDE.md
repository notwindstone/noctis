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
| Desktop | **Planned: Tauri** (not set up yet) | — |
| iOS | Maybe later (Capacitor) | — |
| Server | Bun + **Elysia 2.0.0-rc.0** (pinned), PostgreSQL 18 via `Bun.SQL`, Redis 8 via `Bun.RedisClient` (sessions), music-metadata in the local-library plugin | `apps/server` |
| Shared plugin system | Plain TypeScript (no Vue/Bun APIs), fflate for archives | `packages/plugin-core` |
| Example plugins | YouTube Music (youtubei.js 18, bgutils-js 4), Spotify, SoundCloud (web app API, HLS joined into one file), Monochrome (community API instances, FLAC), Liquid Glass (@sohumsuthar/liquid-glass CSS + optics), local-library and MusicBrainz (server), play-stats (both) | `examples/plugins` |
| Dev services | `docker compose up -d` (PostgreSQL + Redis); Nix devshell in `flake.nix` | root |

## Commands

```sh
bun install
bun run dev                 # client at :5173
bun run dev:server          # server at :4747 (needs PostgreSQL + Redis)
bun run typecheck           # every workspace
bun test                    # plugin-core + server; needs NOCTIS_TEST_DATABASE_URL / NOCTIS_TEST_REDIS_URL
bun run pack-plugin examples/plugins/<name>     # → dist-plugins/<name>.noctis
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
