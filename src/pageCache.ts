import { sessionKey } from './services/session'
import { readJson, writeJson } from './storage'

/**
 * Last fetched content of the Home and Library pages, kept on the device so the app
 * opens straight into it. Pages refetch only on pull-to-refresh, or when what the
 * content depends on changes (service, account, language, region): `sessionKey`.
 */
function contentKey(): string {
  return sessionKey.value
}

interface Entry<T> {
  key: string
  savedAt: number
  data: T
}

export function readPageCache<T>(name: string): T | null {
  const entry = readJson<Entry<T> | null>(`noctis:cache:${name}`, null)
  return entry && entry.key === contentKey() ? entry.data : null
}

export function writePageCache<T>(name: string, data: T) {
  writeJson(`noctis:cache:${name}`, { key: contentKey(), savedAt: Date.now(), data } satisfies Entry<T>)
}
