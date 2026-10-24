# Server plugins

A Noctis server (`apps/server`, Bun + Elysia 2) is extended with plugins, like the
client. A plugin can run on one side or on both. When it runs on both, the server can
**require clients to have its client half**, the way a modded Minecraft server refuses
players without its mods.

Client plugins are covered in [PLUGINS.md](PLUGINS.md). Both sides share one plugin
system, [`packages/plugin-core`](../packages/plugin-core):

- the archive and manifest format;
- versions and dependency ranges;
- load order;
- the hook engine;
- the `Plugin` base: lifecycle, hook events and logging;
- client–server negotiation.

## Sides

`metadata.json` says where the plugin runs with `"side"`:

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
- `client` only applies to `"both"`:
  - `required` (default `true`): whether clients without the client half are refused.
  - `versions` (default `^<version>`): which client-half versions the server accepts.

The example is [`examples/plugins/play-stats`](../examples/plugins/play-stats). Clients
report plays and the server serves shared charts. Pack it with
`bun run pack-plugin examples/plugins/play-stats`. If a folder has `src/server.ts`
instead of `server.js`, the script builds it with Bun, leaving `elysia` to the server.

## Installing

Server plugins are **trusted code** with the server's full access, as with Minecraft
server mods. Only the instance owner installs them, by putting them in the plugins
directory: `$NOCTIS_PLUGINS_DIR`, by default `data/plugins`. There is no API to install
plugins, so a public instance can't be made to run someone else's code.

Each entry in the plugins directory is one of:
- a `.noctis` or `.zip` archive;
- a folder with `metadata.json` and `server.js` (plus `index.js` for `"both"`), which is
  handy while developing.

At startup the server:
- loads plugins with their dependencies first;
- skips any plugin whose dependency is missing, the wrong version, or failed to start,
  and logs why.

## The server half

`server.js` is an ES module whose default export is called once at startup:

```js
export default function ({ Plugin, Noctis }) {
  const { t } = Noctis.packages.elysia // the server's Elysia, and its schema builder

  Plugin.routes((app) =>
    app
      // Elysia 2: (path, hook, handler)
      .post('/plays', { body: t.Object({ id: t.String() }) }, ({ body }) => {
        const plays = Plugin.storage.get(`plays:${body.id}`, 0) + 1
        Plugin.storage.set(`plays:${body.id}`, plays)
        return { plays }
      })
      .get('/top', () => /* … */ []),
  )

  Plugin.subscribe('lifecycle::disable', () => Plugin.removeRoutes())
}
```

### `Plugin`

The base is the same as on the client: `subscribe`/`unsubscribe` for hook and lifecycle
events, plus `log`, `warn` and `error`. On top of that:

| | |
| --- | --- |
| `Plugin.routes(build)` | Routes under `/api/plugins/<id>/`. `build` receives a fresh Elysia instance and returns it. Calling it again replaces the routes. |
| `Plugin.removeRoutes()` | Takes the routes down. |
| `Plugin.storage.get(key, fallback?)`, `.set(key, value)`, `.remove(key)`, `.keys(prefix?)` | JSON key/value storage in the server's SQLite database (`data/noctis.db`). Each plugin only sees its own keys. |

### `Noctis`

| | |
| --- | --- |
| `Noctis.packages.elysia` | The server's Elysia module, including `t` for schemas. |
| `Noctis.hooks`, `Noctis.hookNames` | Hook points. |
| `Noctis.plugins()` | Every plugin: id, manifest and state. |
| `Noctis.server.name` | The instance name. |
| `Noctis.log(source, level, …)` | The server log. |

### Hooks

Subscribe with `Plugin.subscribe('hook::<name>::<before|after>', fn)`. The semantics
are the client's: return `{ status: 'stop', response }` to short-circuit.

| Hook | Receives |
| --- | --- |
| `onRequest` | before: `{ request, path, clientPlugins }`. Stop with a `Response` to answer the request yourself, e.g. for auth, rate limits or bans. |
| `onHandshake` | after: `{ response }`, the handshake a client gets. Change it to add information. |

## Clients and servers agreeing on plugins

1. With every request, a client says which plugins it runs:
   `x-noctis-plugins: play-stats@1.0.0,lyrics@2.3.1`.
2. `GET /api/v1/handshake` answers with:
   - the client plugins this server wants (`plugins`), each with its accepted
     `versions`, whether it's `required`, the SHA-256 of its `index.js`, and a
     `download` path;
   - what this client is missing or has in the wrong version (`result`).
3. If a client lacks a required plugin, every other API request gets **428 Precondition
   Required** with the same handshake body. Turn this off with
   `NOCTIS_ENFORCE_CLIENT_PLUGINS=false`; a plugin's own routes always require its
   client half anyway.
4. The client downloads the missing halves from
   `/api/v1/plugins/<id>/client.noctis`. Those archives contain the client half only,
   with `"side": "client"`, so clients never receive server code. The client then:
   - checks each archive's `index.js` against the announced hash;
   - asks the user once;
   - installs and enables the plugins, and reconnects.

The client does this in **Settings → Server**.

## API

| | |
| --- | --- |
| `GET /api/v1/info` | Name, version, protocol. |
| `GET /api/v1/handshake` | Client plugin requirements, and what the calling client is missing. |
| `GET /api/v1/plugins` | The server's plugins and their states. |
| `GET /api/v1/plugins/:id/client.noctis` | A running `"both"` plugin's client half. |
| `ANY /api/plugins/:id/*` | A plugin's own routes. |

CORS is open (`*`): the API uses no cookies.

## Configuration

Settings come from environment variables; see `apps/server/.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOCTIS_NAME` | `Noctis` | Instance name |
| `NOCTIS_PORT` | `4747` | Port |
| `NOCTIS_HOST` | `0.0.0.0` | Address to listen on |
| `NOCTIS_DATA_DIR` | `./data` | Database, plugin cache, and plugins by default |
| `NOCTIS_PLUGINS_DIR` | `$NOCTIS_DATA_DIR/plugins` | Plugins to load |
| `NOCTIS_ENFORCE_CLIENT_PLUGINS` | `true` | Refuse clients missing required plugins |
| `NOCTIS_MAX_BODY_BYTES` | `1048576` | Largest request body |

## Not there yet

- **No accounts.** Every API call is anonymous, so a public instance should keep
  plugins that write data behind a reverse proxy, or add auth in an `onRequest` hook.
- **No admin API.** Plugins can't be enabled, disabled or reloaded without a restart.
- **No server services yet.** Plugins can't define music services or recommendation
  changes, and there's no OpenSubsonic API. Those come next (see [VISION.md](VISION.md)).
