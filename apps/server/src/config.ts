import { join, resolve } from 'node:path'

/** Server settings, from environment variables (see .env.example). */
export interface ServerConfig {
  name: string
  port: number
  hostname: string
  /** Where the database, plugin cache and plugins live. */
  dataDir: string
  /** .noctis archives (or unpacked plugin folders) to load at startup. */
  pluginsDir: string
  /**
   * Refuse API requests from clients that lack a required client plugin, the way a
   * Minecraft server refuses players without its mods. Off: only the plugin's own
   * routes check.
   */
  enforceClientPlugins: boolean
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number
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
  }
}
