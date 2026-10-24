import { Database } from 'bun:sqlite'

/**
 * Per-plugin key/value storage in SQLite, like the client's Plugin.storage but on the
 * server. Values are JSON; each plugin only sees its own keys.
 */
export class PluginStorage {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('CREATE TABLE IF NOT EXISTS plugin_data (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin, key))')
  }

  forPlugin(plugin: string) {
    const db = this.db
    const get = db.query<{ value: string }, { plugin: string; key: string }>('SELECT value FROM plugin_data WHERE plugin = $plugin AND key = $key')
    const set = db.query('INSERT INTO plugin_data (plugin, key, value) VALUES ($plugin, $key, $value) ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value')
    const remove = db.query('DELETE FROM plugin_data WHERE plugin = $plugin AND key = $key')
    const keys = db.query<{ key: string }, { plugin: string; prefix: string }>("SELECT key FROM plugin_data WHERE plugin = $plugin AND key LIKE $prefix ESCAPE '\\' ORDER BY key")
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const row = get.get({ plugin, key })
        return row ? (JSON.parse(row.value) as T) : fallback
      },
      set(key: string, value: unknown) {
        set.run({ plugin, key, value: JSON.stringify(value) })
      },
      remove(key: string) {
        remove.run({ plugin, key })
      },
      /** Keys starting with `prefix`. */
      keys(prefix = ''): string[] {
        const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`)
        return keys.all({ plugin, prefix: `${escaped}%` }).map((row) => row.key)
      },
    }
  }

  close() {
    this.db.close()
  }
}

export type PluginStore = ReturnType<PluginStorage['forPlugin']>
