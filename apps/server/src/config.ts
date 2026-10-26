import { join, resolve } from 'node:path'

/** Server settings, from environment variables (see .env.example). */
export interface ServerConfig {
  name: string
  port: number
  hostname: string
  /** Where the plugin cache and plugins live. */
  dataDir: string
  /** .noctis archives (or unpacked plugin folders) to load at startup. */
  pluginsDir: string
  /**
   * Refuse API requests from clients that lack a required client plugin, the way a
   * Minecraft server refuses players without its mods. Off: only the plugin's own
   * routes check. Never applies to /rest (OpenSubsonic clients can't negotiate).
   */
  enforceClientPlugins: boolean
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number
  /** PostgreSQL: catalog, users, groups, queues, plugin storage. */
  databaseUrl: string
  /** Redis: sessions. */
  redisUrl: string
  /** Sessions expire after this many days without use. */
  sessionTtlDays: number
  /** Creates this admin on first start, when there are no users yet. */
  admin: { name: string; password: string } | null
  /** Anyone can create an account (POST /api/noctis/v1/auth/register). */
  openRegistration: boolean
  /**
   * Requests without a session act as the "guests" group (browse and stream, by
   * default), for instances that don't require accounts.
   */
  guestAccess: boolean
  /** The browser client at "/": its build directory, or null when turned off. */
  webClient: string | null
}

const flag = (value: string | undefined, fallback: boolean) => (value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value))

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dataDir = resolve(env.NOCTIS_DATA_DIR ?? 'data')
  return {
    name: env.NOCTIS_NAME ?? 'Noctis',
    port: Number(env.NOCTIS_PORT ?? 4747),
    hostname: env.NOCTIS_HOST ?? '0.0.0.0',
    dataDir,
    pluginsDir: resolve(env.NOCTIS_PLUGINS_DIR ?? join(dataDir, 'plugins')),
    enforceClientPlugins: flag(env.NOCTIS_ENFORCE_CLIENT_PLUGINS, true),
    maxBodyBytes: Number(env.NOCTIS_MAX_BODY_BYTES ?? 1024 * 1024),
    databaseUrl: env.NOCTIS_DATABASE_URL ?? 'postgres://noctis:noctis@localhost:5432/noctis',
    redisUrl: env.NOCTIS_REDIS_URL ?? 'redis://localhost:6379',
    sessionTtlDays: Number(env.NOCTIS_SESSION_TTL_DAYS ?? 90),
    admin: env.NOCTIS_ADMIN_USER && env.NOCTIS_ADMIN_PASSWORD ? { name: env.NOCTIS_ADMIN_USER, password: env.NOCTIS_ADMIN_PASSWORD } : null,
    openRegistration: flag(env.NOCTIS_OPEN_REGISTRATION, false),
    guestAccess: flag(env.NOCTIS_GUEST_ACCESS, false),
    webClient: flag(env.NOCTIS_WEB_CLIENT, true) ? resolve(env.NOCTIS_WEB_CLIENT_DIR ?? join(import.meta.dir, '../../client/dist')) : null,
  }
}
