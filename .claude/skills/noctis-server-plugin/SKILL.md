---
name: noctis-server-plugin
description: Write or change a Noctis server plugin (side "server" or "both"): custom routes under /api/plugins/<id>, catalog indexers, audio providers, OpenSubsonic extensions, permissions, storage, server hooks. Use for anything in apps/server/src/plugins or examples/plugins/{local-library,musicbrainz,play-stats}.
---

# Noctis server plugins

Reference: [docs/SERVER-PLUGINS.md](../../../docs/SERVER-PLUGINS.md). Server plugins are **trusted code** with the
server's full access, installed from disk only (`$NOCTIS_PLUGINS_DIR`, default `data/plugins`); there is no
install API. Client basics are in [noctis-plugin-dev](../noctis-plugin-dev/SKILL.md).

## Shape

`metadata.json`: `"side": "server" | "both"`, semver `version` (required for these sides), optional
`dependencies`, `platforms` (for the client half), `client: { required, versions }` for `"both"`.
Code: `src/server.ts` (built with Bun; `elysia` is left to the server) or `server.js`; a "both" plugin also has
`index.js`/`src/index.ts` for the app. Pack with `bun run pack-plugin examples/plugins/<id>`.

```ts
export default async function ({ Plugin, Noctis }) {
  const { t } = Noctis.packages.elysia
  Plugin.routes((app) =>
    app.post('/things', { body: t.Object({ id: t.String() }) }, async ({ body, request, status }) => {   // Elysia 2: (path, hook, handler)
      const user = await Noctis.auth.userFrom(request)
      if (!user || !Noctis.auth.can(user, 'myplugin.use')) return status(403, { error: 'Not allowed' })
      return { ok: true }
    }),
  )
  Plugin.subscribe('lifecycle::disable', () => Plugin.removeAll())
}
```

## Pieces

| Need | API |
| --- | --- |
| Routes | `Plugin.routes(build)` (under `/api/plugins/<id>/`; the client half is required for them) |
| Index songs | `Noctis.catalog.upsertSong({ …, source: { provider, externalId, contentType, suffix, bitrate } })` |
| Serve audio | `Plugin.defineProvider(id, { name, stream({ song, source, range, maxBitRate }), cover })`; honour `range` or return a URL to relay |
| Scans | `Plugin.defineScanner(id, { name, scan, status })` (runs under `startScan`) |
| Permissions | `Plugin.permissions.define('<plugin id>.name', description)` |
| OpenSubsonic | `Plugin.subsonic.endpoint(name, handler)` / `.extension(name, versions)`; built-ins can't be replaced (use `onSubsonic`) |
| Storage | `Plugin.storage.get/set/remove/keys/entries` (async, PostgreSQL, per plugin) |
| Hooks | `onRequest`, `onHandshake`, `onSubsonic`, `onStream`, `onSources`, `onRecommend` |
| Recommendations | `Noctis.recommend({ user, seed?, limit })` after every plugin's hooks |

## Traps

- **Elysia 2.0.0-rc.0:** routes are `(path, hook, handler)`; the 1.x order throws.
- **Bun.SQL:** strings are sent as JSON, so `${JSON.stringify(x)}::jsonb` double-encodes; use
  `(${JSON.stringify(x)}::text)::jsonb`. Arrays: `sql.array(list, 'text')`; lists: `IN ${sql(list)}`. Read BIGINT
  as `::float8`. The jsonb `?` operator doesn't work in templates.
- `/rest` accepts API keys only and is never subject to client-plugin checks; Noctis endpoints are under
  `/api/noctis/v1`.
- `removeAll()` on disable undoes routes, providers, scanners, endpoints and permissions: call it.
- No copyrighted audio in tests or demos: generate tones (`apps/server/test/helpers.ts`).

## Verify

`bun run typecheck`, then `bun test` (needs PostgreSQL and Redis: `NOCTIS_TEST_DATABASE_URL` and `NOCTIS_TEST_REDIS_URL`) and add a test beside the existing ones in `apps/server/test` for new routes. For a "both" plugin, also
check the handshake: a client without the required half gets 428 until it installs it from
`/api/noctis/v1/plugins/<id>/client.noctis`.
