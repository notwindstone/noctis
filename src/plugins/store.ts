import { isBoolean, persisted } from '../storage'

/**
 * Installed plugins, kept on the device.
 *
 * A plugin archive (`.zip` or `.noctis`) holds `index.js` and `metadata.json`; the
 * archive's file name is the plugin id. Enabled state is keyed by the SHA-256 of
 * `index.js` (as in Kaede): if the code changes — even under the same id — the plugin
 * is no longer enabled until the user approves the new code.
 */

export interface PluginMetadata {
  name: string
  version: string
  authors: string[]
  /** Only "unrestricted" is supported for now (no sandbox). */
  type: 'unrestricted'
  description?: string
  /** Image URL (https: or data:) shown in the plugin list. */
  logo?: string
  /** Where the source lives, e.g. a repository URL. */
  source?: string
  categories?: string[]
  /** ISO 639-1 codes. */
  languages?: string[]
}

export interface InstalledPlugin {
  id: string
  code: string
  sha256: string
  metadata: PluginMetadata
  installedAt: number
}

const isArray = (value: unknown) => Array.isArray(value)
const isRecord = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)

export const installedPlugins = persisted<InstalledPlugin[]>('noctis:plugins', [], isArray)

/** sha256 → enabled. */
export const enabledHashes = persisted<Record<string, boolean>>('noctis:plugins:enabled', {}, isRecord)

/** sha256 of code the user agreed to run (enabling new code asks first). */
export const approvedHashes = persisted<Record<string, true>>('noctis:plugins:approved', {}, isRecord)

/** Master switch; off starts the app without running any plugin ("safe mode"). */
export const pluginsActive = persisted('noctis:plugins:active', true, isBoolean)

/** Off unless turned on. */
export function isEnabled(plugin: InstalledPlugin): boolean {
  return enabledHashes.value[plugin.sha256] === true
}

export function setEnabledFlag(plugin: InstalledPlugin, enabled: boolean) {
  enabledHashes.value = { ...enabledHashes.value, [plugin.sha256]: enabled }
}

export function findPlugin(id: string): InstalledPlugin | undefined {
  return installedPlugins.value.find((plugin) => plugin.id === id)
}

export function describeAuthors(metadata: PluginMetadata): string {
  return metadata.authors.length > 0 ? metadata.authors.join(', ') : 'Unknown author'
}
