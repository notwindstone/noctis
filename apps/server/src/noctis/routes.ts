import { checkClientPlugins, decodePluginsHeader, PLATFORM_HEADER, PLUGINS_HEADER, PROTOCOL_VERSION, type ClientPlugin, type HandshakeResponse } from '@noctis/plugin-core'
import { Elysia, t } from 'elysia'
import { AuthError, can, type User } from '../auth'
import type { Services } from '../services'
import { songToChild } from '../subsonic/mappers'

export const SERVER_VERSION = '0.3.0'

/**
 * /noctis/v1: what OpenSubsonic doesn't cover.
 *
 *   GET    /info                          name, versions, library size, guest access
 *   GET    /handshake                     client plugins the server wants, and what's missing
 *   GET    /plugins                       the server's plugins
 *   GET    /plugins/:id/client.noctis     a "both" plugin's client half
 *   POST   /auth/login                    { username, password } → a session token
 *   POST   /auth/register                 (if open registration is on)
 *   POST   /auth/logout                   end the calling session
 *   GET    /me                            the caller: user, groups, permissions
 *   GET    /songs/:id/sources             every source of a song ("Play from")
 *   POST   /sources                       { ids } → sources of many songs at once
 *   GET    /recommendations               ?seed=<song>&limit=&context=
 *   GET    /providers                     audio providers
 *   GET    /scan, POST /scan              library scan status / start one
 *   /admin/users, /admin/groups, /admin/permissions   (users.manage)
 *
 * Sessions: `Authorization: Bearer <token>`. The same token is OpenSubsonic's apiKey.
 */

/** What a client with these plugins (on this platform) is missing, after plugins' onHandshake hooks. */
export async function handshakeFor({ config, plugins }: Services, client: ClientPlugin[], platform?: string | null): Promise<HandshakeResponse> {
  const requirements = plugins.clientRequirements()
  const response: HandshakeResponse = {
    protocol: PROTOCOL_VERSION,
    server: { name: config.name, version: SERVER_VERSION },
    plugins: requirements,
    result: checkClientPlugins(requirements, client, platform),
  }
  const after = await plugins.hooks.run<HandshakeResponse>('onHandshake', 'after', { response })
  return after.stopped ? after.response : response
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const label = t.Optional(t.String({ maxLength: 100 }))

export function noctisRoutes(services: Services) {
  const { config, accounts, sessions, catalog, recommender, providers, plugins, scanners, sources, permissions } = services
  const handshake = (request: Request) => handshakeFor(services, decodePluginsHeader(request.headers.get(PLUGINS_HEADER)), request.headers.get(PLATFORM_HEADER))

  const tokenOf = (request: Request) => /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]

  /** The caller, checked for a permission (and for an account, if `account`). */
  async function caller(request: Request, permission: string | null, account = false): Promise<User> {
    let user: User | null
    try {
      user = await services.authenticate(tokenOf(request))
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : 'Unauthorized')
    }
    if (!user) throw new HttpError(401, 'Sign in first: send Authorization: Bearer <session token>')
    if (account && user.guest) throw new HttpError(401, 'Sign in to an account for this')
    if (permission && !can(user, permission)) throw new HttpError(403, `You don't have the "${permission}" permission`)
    return user
  }

  const publicUser = (user: User) => ({ id: user.id, name: user.name, groups: user.groups, permissions: user.permissions, guest: user.guest })

  return (
    new Elysia({ prefix: '/noctis/v1' })
      .onError(({ error }) => {
        if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status })
        if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.code === 40 || error.code === 44 ? 401 : 400 })
      })

      .get('/info', async () => ({
        name: config.name,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        openSubsonic: '/rest',
        openRegistration: config.openRegistration,
        guestAccess: config.guestAccess,
        library: await catalog.counts(),
      }))

      .get('/handshake', ({ request }) => handshake(request))

      .get('/plugins', () =>
        [...plugins.plugins.entries()].map(([id, { archive, state }]) => ({
          id,
          name: archive.manifest.name,
          version: archive.manifest.version,
          side: archive.manifest.side,
          description: archive.manifest.description,
          authors: archive.manifest.authors,
          source: archive.manifest.source,
          platforms: archive.manifest.platforms,
          state,
          client: archive.manifest.client,
        })),
      )

      .get('/plugins/:id/client.noctis', ({ params, status }) => {
        const bytes = plugins.clientArchive(params.id)
        if (!bytes) return status(404, { error: `No client plugin "${params.id}" on this server` })
        // Its own type, so Android offers to open the download with Noctis (see AndroidManifest.xml).
        return new Response(bytes, { headers: { 'content-type': 'application/x-noctis-plugin', 'content-disposition': `attachment; filename="${params.id}.noctis"` } })
      })

      /* ---------------- Accounts and sessions ---------------- */

      .post('/auth/login', { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ maxLength: 1024 }), label }) }, async ({ body }) => {
        const user = await accounts.verifyPassword(body.username, body.password)
        return { token: await sessions.create(user, body.label ?? 'Noctis client'), user: publicUser(user) }
      })

      .post('/auth/register', { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ minLength: 8, maxLength: 1024 }), label }) }, async ({ body, status }) => {
        if (!config.openRegistration) return status(403, { error: 'Registration is closed on this server' })
        const user = await accounts.create(body.username, body.password)
        return { token: await sessions.create(user, body.label ?? 'Noctis client'), user: publicUser(user) }
      })

      .post('/auth/logout', async ({ request }) => {
        const token = tokenOf(request)
        if (token) await sessions.revoke(token)
        return { ok: true }
      })

      .get('/me', async ({ request }) => publicUser(await caller(request, null)))

      /* ---------------- Sources and recommendations ---------------- */

      .get('/songs/:id/sources', async ({ request, params, status }) => {
        const user = await caller(request, 'library.read')
        const song = await catalog.song(params.id, user.id)
        if (!song) return status(404, { error: 'No such song' })
        return sources.forSong(song, user)
      })

      .post('/sources', { body: t.Object({ ids: t.Array(t.String({ maxLength: 100 }), { maxItems: 200 }) }) }, async ({ request, body }) => {
        const user = await caller(request, 'library.read')
        return { songs: await sources.forSongs(body.ids, user) }
      })

      .get(
        '/recommendations',
        { query: t.Object({ seed: t.Optional(t.String({ maxLength: 100 })), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })), context: t.Optional(t.String({ maxLength: 50 })) }) },
        async ({ request, query }) => {
          const user = await caller(request, 'library.read')
          const ids = await recommender.recommend({ user: user.id, seed: query.seed, limit: query.limit ?? 50, context: query.context })
          return { songs: (await catalog.songs(ids, user.id)).map(songToChild) }
        },
      )

      .get('/providers', () => providers.list())

      .get('/scan', () => scanners.status())

      .post('/scan', async ({ request }) => {
        await caller(request, 'library.scan')
        void scanners.scanAll()
        return { ...scanners.status(), scanning: true }
      })

      /* ---------------- Administration (users.manage) ---------------- */

      .get('/admin/users', async ({ request }) => {
        await caller(request, 'users.manage')
        return (await accounts.users()).map(publicUser)
      })

      .post(
        '/admin/users',
        { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ minLength: 8, maxLength: 1024 }), groups: t.Optional(t.Array(t.String(), { maxItems: 50 })) }) },
        async ({ request, body }) => {
          await caller(request, 'users.manage')
          return publicUser(await accounts.create(body.username, body.password, body.groups ?? ['users']))
        },
      )

      .patch(
        '/admin/users/:name',
        { body: t.Object({ groups: t.Optional(t.Array(t.String(), { maxItems: 50 })), password: t.Optional(t.String({ minLength: 8, maxLength: 1024 })) }) },
        async ({ request, params, body, status }) => {
          const admin = await caller(request, 'users.manage')
          const user = await accounts.find(params.name)
          if (!user) return status(404, { error: 'No such user' })
          if (body.groups) {
            // Don't let an admin lock everyone out by removing their own admin group.
            if (user.id === admin.id && can(admin, '*') && !body.groups.includes('admins')) return status(400, { error: "You can't remove yourself from admins" })
            await accounts.setGroups(user.id, body.groups)
          }
          if (body.password) {
            await accounts.setPassword(user.id, body.password)
            await sessions.revokeAll(user.id)
          }
          return publicUser((await accounts.byId(user.id))!)
        },
      )

      .delete('/admin/users/:name', async ({ request, params, status }) => {
        const admin = await caller(request, 'users.manage')
        const user = await accounts.find(params.name)
        if (!user) return status(404, { error: 'No such user' })
        if (user.id === admin.id) return status(400, { error: "You can't delete yourself" })
        await sessions.revokeAll(user.id)
        await accounts.deleteUser(user.id)
        return { ok: true }
      })

      .get('/admin/groups', async ({ request }) => {
        await caller(request, 'users.manage')
        return accounts.groups()
      })

      .put(
        '/admin/groups/:name',
        { body: t.Object({ description: t.Optional(t.String({ maxLength: 200 })), permissions: t.Array(t.String({ maxLength: 100 }), { maxItems: 200 }) }) },
        async ({ request, params, body, status }) => {
          await caller(request, 'users.manage')
          const known = new Set(permissions.list().map((permission) => permission.name))
          const unknown = body.permissions.filter((permission) => !known.has(permission))
          if (unknown.length > 0) return status(400, { error: `Unknown permissions: ${unknown.join(', ')}` })
          await accounts.saveGroup(params.name, body)
          return (await accounts.groups()).find((group) => group.name === params.name)
        },
      )

      .delete('/admin/groups/:name', async ({ request, params }) => {
        await caller(request, 'users.manage')
        await accounts.deleteGroup(params.name)
        return { ok: true }
      })

      .get('/admin/permissions', async ({ request }) => {
        await caller(request, 'users.manage')
        return permissions.list()
      })
  )
}
