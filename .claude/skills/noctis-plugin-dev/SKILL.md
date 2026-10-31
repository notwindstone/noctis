---
name: noctis-plugin-dev
description: Write, change, pack, test or debug a Noctis client plugin (a .noctis archive that adds screens, buttons, settings, hooks, themes or a tray/desktop behaviour). Use when the task is a new plugin under examples/plugins, a change to one, or anything that reaches the app through window.__NOCTIS__ / scopedThis. For a streaming-service plugin also read noctis-service-plugin; for the server half read noctis-server-plugin.
---

# Noctis client plugins

The reference is [docs/PLUGINS.md](../../../docs/PLUGINS.md); read the section you need
rather than guessing an API. This skill is the working method and the traps.

## Shape of a plugin

```
examples/plugins/<id>/
  metadata.json        name, type "unrestricted", version, platforms, description, source, categories
  src/index.ts         default export (scope: PluginScope) => void   (or a plain index.js)
  src/host.ts          copy from examples/plugins/offline-wave/src/host.ts (types + `Noctis`)
```

- The **folder name is the plugin id** (and the archive name); `Plugin.storage` and logs are keyed by it.
- `platforms`: `["*"]` by default; `["desktop"]`, `["android"]`… when it needs that app. The app refuses
  to install a plugin made for another platform.
- Pack: `bun run pack-plugin examples/plugins/<id>` → `dist-plugins/<id>.noctis`. Typecheck: `bun run typecheck`.

## Skeleton (attach / detach)

Disabling a plugin only runs `lifecycle::disable`; **undoing everything is the plugin's job**, and
enabling again in the same session runs `lifecycle::dirty-enable`, not the code.

```ts
import type { PluginScope } from './host'

export default function myPlugin({ Plugin, Noctis }: PluginScope) {
  const { player } = Noctis.libs
  const attach = () => { /* subscribe, registerAction, push collection entries, defineSection */ }
  const detach = () => { /* the exact reverse, incl. timers */ }
  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  Plugin.log('ready')
}
```

Good small examples: `tray-play-pause` (hook + timer), `offline-wave` (action, section, settings),
`lyrics` (replaces a component), `material-2`/`liquid-glass` (themes).

## What a plugin can touch

| Want | Use |
| --- | --- |
| A button in a menu / under the player | `Plugin.registerAction(id, fn)` + push to `Noctis.ActionCollections.songMenu` / `playerActions`… |
| A settings page or rows | `Plugin.defineSection({ id, icon, title }, [Noctis.group(...)])`; rows use **getters** for live fields |
| Replace UI | `Plugin.registerComponent('PlayerArt', Comp)` and `restoreComponent` on disable; write `h()` render functions (no template compiler) |
| Intercept | hooks `onRequest`, `onPlay`, `onLanguageChange`, `onTrayClick` via `Plugin.subscribe('hook::<name>::before' \| '::after', fn)`; return `{ status: 'stop', response? }` to short-circuit |
| Player / library / offline | `Noctis.libs.player`, `.library`, `.offline`, `.navigation`, `.notifications`, `.ui`, `.snackbar`, `.theme`, `.preferences` |
| Persist data | `Plugin.storage.get/set/remove` (small JSON). **Never write files or pick a storage location**: Noctis keeps everything under its data directory and plugins get no file access |
| HTTP | `Noctis.libs.http` (`nativeFetch` on desktop = no CORS, any header; `request` on devices). In a plain browser CORS applies |

Use the app's registries so other plugins and themes keep working: `Noctis.C.MIcon`, `Noctis.C.Thumb`,
never hard-coded elements for things the registry provides. Download songs only through
`Noctis.libs.offline.download` (the queue, retries and notification come with it).

## Traps that have bitten this project

- **Module-level order:** a `const` used by an array/object built at load time must be defined *above*
  it (a helper below the settings blocks gave `x is not a function` and a blank app). Settings rows and
  registries evaluate at startup.
- **Code fingerprint:** enabled/approved state is keyed by the SHA-256 of `index.js`. Every rebuild
  needs re-approval in the app; that is expected, not a bug.
- **Desktop has no cookie jar** (plugin-http is built without `cookies`): send `Cookie` yourself, or use
  `Noctis.libs.auth.openCookieLogin`.
- **Ids from other services contain `:`**; keep any file/key you derive from them plain.
- **Don't poll or loop in hooks** (`onRequest` runs for every service call).
- A hook that throws is logged and skipped; do your own `try/catch` around anything flaky.
- CSS class names are global: prefix yours.

## Verify before you hand it over

1. `bun run typecheck` and `bun run pack-plugin examples/plugins/<id>`.
2. Put pure logic (parsers, matching) in a file that does **not** import `./host` so `bun` can run it
   directly; `host.ts` reads `window.__NOCTIS__` at import time and fails outside the app.
3. Drive it in a real page. Headless Chromium + Playwright (`npm i playwright` in a scratch directory outside the repo; use an installed Chromium via `executablePath`, `--disable-blink-features=AutomationControlled` for YouTube) against
   `bunx vite --port <free port>` (the dev server proxies YouTube/Spotify hosts; ENOSPC watcher errors
   are harmless). Seed the plugin without clicking through consent by writing localStorage before load:
   `noctis:plugins` (`[{ id, code, sha256, metadata, installedAt }]` from `readPluginArchive` in
   `packages/plugin-core`), `noctis:plugins:enabled` and `noctis:plugins:approved` (`{ [sha256]: true }`).
   Then call into `window.__NOCTIS__.libs.*` (not dynamic imports) and assert on state.
4. Load the **built** app (`bunx vite build`, `vite preview`) and check for page errors before shipping a
   build; a startup exception blanks the whole app.
5. Don't `pkill -f <pattern>` from the shell tool: the pattern also matches the command line itself.
