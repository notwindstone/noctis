import { computed, shallowReactive } from 'vue'
import { writeLog } from './log'
import { checkPluginUrl, downloadBytes, installFromArchive, PluginInstallError, type InstallResult } from './install'
import { findPlugin, installedPlugins } from './store'
import { persisted } from '../storage'

/**
 * Plugin collections: a link to an index (`plugins.json`) that lists plugins and where to get
 * them, like a package repository. Add it once and Noctis can install what it lists, see which
 * installed plugins have a newer version, and update them in one go.
 *
 *   { "name": "My plugins",
 *     "plugins": [ { "id": "lyrics", "name": "Lyrics", "version": "1.2.0", "sha256": "…",
 *                    "url": "lyrics.noctis", "description": "…" } ] }
 *
 * `url` is relative to the index (default `<id>.noctis`); `sha256` is the SHA-256 of the
 * plugin's index.js, which is how an update is told from what is installed without downloading
 * it. `bun run pack-plugin --all` writes one for the example plugins, and `bun run serve-plugins`
 * serves it, rebuilding as the sources change: add its address once, press "Update all" after
 * each change. Plugins from a collection are installed like any other archive (src/plugins/install.ts),
 * so they update in place and keep their settings.
 */

export interface CollectionEntry {
  id: string
  name: string
  version: string
  description?: string
  /** Absolute, resolved against the index. */
  url: string
  sha256?: string
  authors?: string[]
}

export interface SavedCollection {
  url: string
  name: string
}

export type CollectionState =
  | { status: 'loading' }
  | { status: 'ready'; name: string; plugins: CollectionEntry[]; checkedAt: number }
  | { status: 'error'; message: string }

export const collections = persisted<SavedCollection[]>('noctis:plugin-collections', [], (value) => Array.isArray(value))
/** Check the collections when the app starts, and say if something has an update. */
export const checkOnStart = persisted('noctis:plugin-collections:check', true, (value) => typeof value === 'boolean')

/** Collection url → what its index said last time. */
export const states = shallowReactive<Record<string, CollectionState>>({})

export type EntryStatus = 'new' | 'update' | 'current'

/** What installing this entry would do here. */
export function statusOf(entry: CollectionEntry): EntryStatus {
  const installed = findPlugin(entry.id)
  if (!installed) return 'new'
  if (entry.sha256) return installed.sha256 === entry.sha256 ? 'current' : 'update'
  return installed.metadata.version === entry.version ? 'current' : 'update'
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

function parseIndex(url: string, json: unknown): { name: string; plugins: CollectionEntry[] } {
  const raw = json as { name?: unknown; plugins?: unknown } | null
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) throw new PluginInstallError("That address isn't a plugin collection (it has no plugin list)")
  const plugins: CollectionEntry[] = []
  for (const item of raw.plugins as Record<string, unknown>[]) {
    const id = text(item?.id)
    if (!id) continue
    let resolved: URL
    try {
      resolved = checkPluginUrl(new URL(text(item.url) ?? `${id}.noctis`, url).href)
    } catch {
      continue
    }
    plugins.push({
      id,
      name: text(item.name) ?? id,
      version: text(item.version) ?? '',
      description: text(item.description),
      url: resolved.href,
      sha256: text(item.sha256),
      authors: Array.isArray(item.authors) ? item.authors.filter((author): author is string => typeof author === 'string') : undefined,
    })
  }
  return { name: text(raw.name) ?? new URL(url).host, plugins }
}

/** Read an index, without saving anything. */
async function fetchIndex(url: string) {
  const bytes = await downloadBytes(url)
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new PluginInstallError("That address doesn't hold a plugin collection (it isn't JSON)")
  }
  return parseIndex(url, json)
}

export async function refreshCollection(url: string) {
  states[url] = { status: 'loading' }
  try {
    const index = await fetchIndex(url)
    states[url] = { status: 'ready', name: index.name, plugins: index.plugins, checkedAt: Date.now() }
    // The collection's own name, kept for the list while offline.
    collections.value = collections.value.map((item) => (item.url === url && item.name !== index.name ? { ...item, name: index.name } : item))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    states[url] = { status: 'error', message }
    writeLog('noctis', 'warn', `Couldn't read the plugin collection ${url}: ${message}`)
  }
}

export const refreshAll = () => Promise.all(collections.value.map((item) => refreshCollection(item.url)))

export async function addCollection(address: string) {
  const url = checkPluginUrl(address).href
  if (collections.value.some((item) => item.url === url)) throw new PluginInstallError('That collection is already added')
  const index = await fetchIndex(url)
  collections.value = [...collections.value, { url, name: index.name }]
  states[url] = { status: 'ready', name: index.name, plugins: index.plugins, checkedAt: Date.now() }
}

export function removeCollection(url: string) {
  collections.value = collections.value.filter((item) => item.url !== url)
  delete states[url]
}

/** Download and install (or update) one plugin of a collection. */
export async function installEntry(entry: CollectionEntry): Promise<InstallResult> {
  const result = await installFromArchive(`${entry.id}.noctis`, await downloadBytes(entry.url))
  // An index that is out of step with its archives (rebuilt in between) is worth knowing about, not worth refusing.
  if (entry.sha256 && result.plugin.sha256 !== entry.sha256) {
    writeLog('noctis', 'warn', `${entry.id}: the archive isn't the build the collection lists; refresh it`)
  }
  return result
}

/** Every plugin that is installed and has a newer version in some collection (the first collection that lists it wins). */
export const updates = computed<CollectionEntry[]>(() => {
  const seen = new Set<string>()
  const found: CollectionEntry[] = []
  // Depend on what is installed so the list follows installs.
  void installedPlugins.value
  for (const state of Object.values(states)) {
    if (state.status !== 'ready') continue
    for (const entry of state.plugins) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      if (findPlugin(entry.id) && statusOf(entry) === 'update') found.push(entry)
    }
  }
  return found
})

/** Install every available update. Resolves to how many worked and the messages of those that didn't. */
export async function updateAll(): Promise<{ updated: number; failed: string[] }> {
  let updated = 0
  const failed: string[] = []
  for (const entry of [...updates.value]) {
    try {
      await installEntry(entry)
      updated++
    } catch (error) {
      failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { updated, failed }
}
