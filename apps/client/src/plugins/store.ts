import type { PluginManifest } from '@noctis/plugin-core'
import { isBoolean, persisted } from '../storage'

/**
 * Installed plugins, kept on the device.
 *
 * A plugin archive (`.zip` or `.noctis`) holds `index.js` and `metadata.json`; the
 * archive's file name is the plugin id. Enabled state is keyed by the SHA-256 of
 * `index.js` (as in Kaede): if the code changes — even under the same id — the plugin
 * is no longer enabled until the user approves the new code.
 */

/** metadata.json (see @noctis/plugin-core's manifest.ts). */
export type PluginMetadata = PluginManifest

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

// Plugins installed before manifests had `side` and `dependencies`.
if (installedPlugins.value.some((plugin) => !plugin.metadata.side || !plugin.metadata.dependencies)) {
  installedPlugins.value = installedPlugins.value.map((plugin) => ({
    ...plugin,
    metadata: { ...plugin.metadata, side: plugin.metadata.side ?? 'client', dependencies: plugin.metadata.dependencies ?? {} },
  }))
}

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

/**
 * Forget that this code was ever enabled or approved. Removing a plugin does this, so
 * installing it again (the same file, or a copy someone else hands over) starts disabled
 * and asks before it runs.
 */
export function forgetPluginConsent(sha256: string) {
  const { [sha256]: _enabled, ...enabled } = enabledHashes.value
  const { [sha256]: _approved, ...approved } = approvedHashes.value
  enabledHashes.value = enabled
  approvedHashes.value = approved
}

export function findPlugin(id: string): InstalledPlugin | undefined {
  return installedPlugins.value.find((plugin) => plugin.id === id)
}

export function describeAuthors(metadata: PluginMetadata): string {
  return metadata.authors.length > 0 ? metadata.authors.join(', ') : 'Unknown author'
}
