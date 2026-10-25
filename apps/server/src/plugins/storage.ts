import type { Database } from '../db'

/**
 * Per-plugin key/value storage in PostgreSQL, like the client's Plugin.storage but
 * async. Values are JSON; each plugin only sees its own keys.
 */
export class PluginStorage {
  constructor(private readonly sql: Database) {}

  forPlugin(plugin: string) {
    const sql = this.sql
    return {
      async get<T>(key: string, fallback?: T): Promise<T | undefined> {
        const [row] = await sql`SELECT value FROM plugin_data WHERE plugin = ${plugin} AND key = ${key}`
        return row ? (row.value as T) : fallback
      },
      async set(key: string, value: unknown) {
        await sql`
          INSERT INTO plugin_data (plugin, key, value) VALUES (${plugin}, ${key}, (${JSON.stringify(value ?? null)}::text)::jsonb)
          ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value`
      },
      async remove(key: string) {
        await sql`DELETE FROM plugin_data WHERE plugin = ${plugin} AND key = ${key}`
      },
      /** Keys starting with `prefix`. */
      async keys(prefix = ''): Promise<string[]> {
        const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        const rows: { key: string }[] = await sql`SELECT key FROM plugin_data WHERE plugin = ${plugin} AND key LIKE ${pattern} ORDER BY key`
        return rows.map((row) => row.key)
      },
      /** Every key starting with `prefix`, with its value (one query). */
      async entries<T>(prefix = ''): Promise<[string, T][]> {
        const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        const rows: { key: string; value: T }[] = await sql`SELECT key, value FROM plugin_data WHERE plugin = ${plugin} AND key LIKE ${pattern} ORDER BY key`
        return rows.map((row) => [row.key, row.value])
      },
    }
  }
}

export type PluginStore = ReturnType<PluginStorage['forPlugin']>
