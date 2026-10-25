import { RedisClient } from 'bun'
import { Accounts, AuthError, Permissions, Sessions, type User } from './auth'
import { Catalog } from './catalog/catalog'
import { Media } from './catalog/media'
import { Providers, Scanners } from './catalog/providers'
import { Recommender } from './catalog/recommend'
import { Sources } from './catalog/sources'
import type { ServerConfig } from './config'
import { openDatabase } from './db'
import { writeLog } from './log'
import { createServerHooks } from './plugins/hooks'
import { PluginManager } from './plugins/manager'
import { SubsonicRegistry } from './subsonic/router'

export const GUEST_NAME = 'guest'

/** Everything the server is made of, built once and shared by the API and plugins. */
export async function createServices(config: ServerConfig) {
  const sql = await openDatabase(config.databaseUrl)
  const redis = new RedisClient(config.redisUrl)
  await redis.connect()

  const hooks = createServerHooks()
  const accounts = new Accounts(sql)
  await accounts.seed()
  const sessions = new Sessions(redis, accounts, config.sessionTtlDays * 24 * 3600)
  const permissions = new Permissions()
  const catalog = new Catalog(sql)
  const providers = new Providers()
  const scanners = new Scanners()
  const media = new Media(catalog, providers, hooks)
  const recommender = new Recommender(catalog, hooks)
  const subsonic = new SubsonicRegistry()

  /** The guest "user", when guest access is on: the guests group's permissions, no account. */
  async function guest(): Promise<User | null> {
    if (!config.guestAccess) return null
    return { id: 0, name: GUEST_NAME, groups: ['guests'], permissions: await accounts.guestPermissions(), guest: true }
  }

  /**
   * Who's calling: a session token (`Authorization: Bearer`, or OpenSubsonic's apiKey,
   * passed as `token`), else a guest if guest access is on, else null.
   */
  async function authenticate(token: string | null | undefined): Promise<User | null> {
    if (token) return sessions.verify(token)
    return guest()
  }

  async function userFrom(request: Request): Promise<User | null> {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    try {
      return await authenticate(token)
    } catch (error) {
      if (error instanceof AuthError) return null
      throw error
    }
  }

  const plugins = new PluginManager(config, { db: sql, hooks, catalog, providers, scanners, permissions, recommender, subsonic, userFrom })
  const sources = new Sources(catalog, media, providers, plugins, hooks)

  if ((await accounts.count()) === 0) {
    if (config.admin) {
      await accounts.create(config.admin.name, config.admin.password, ['admins', 'users'])
      writeLog('noctis', 'info', `Created admin "${config.admin.name}"`)
    } else {
      writeLog('noctis', 'warn', 'There are no users yet: set NOCTIS_ADMIN_USER and NOCTIS_ADMIN_PASSWORD to create an admin')
    }
  }

  return {
    config,
    sql,
    redis,
    hooks,
    accounts,
    sessions,
    permissions,
    catalog,
    providers,
    scanners,
    media,
    recommender,
    sources,
    subsonic,
    plugins,
    authenticate,
    userFrom,
    async close() {
      redis.close()
      await sql.close()
    },
  }
}

export type Services = Awaited<ReturnType<typeof createServices>>
