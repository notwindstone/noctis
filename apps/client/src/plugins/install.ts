import { CapacitorHttp } from '@capacitor/core'
import { describePlatforms, PluginArchiveError, readPluginArchive, sha256Hex, supportsPlatform, type PluginArchive } from '@noctis/plugin-core'
import { isNative, platform } from '../native'
import { forgetStreams } from '../services/stream'
import { writeLog } from './log'
import { disablePlugin, enablePlugin, isRunning } from './runtime'
import { approvedHashes, findPlugin, forgetPluginConsent, installedPlugins, isEnabled, keepEnabledOnUpdate, type InstalledPlugin } from './store'

/**
 * Installing plugins from archives (read and validated by @noctis/plugin-core): a
 * `.zip` / `.noctis` file with metadata.json and index.js. The archive's file name,
 * minus the extension, is the plugin id. Server plugins are refused, and so are plugins
 * whose `platforms` don't include this app; plugins for both sides install their client half.
 *
 * A plugin that is already installed (same id: `id` in metadata.json, else the file name) is
 * updated in place, so its settings and storage stay, and if it was enabled
 * the new version is too (Settings → Plugins → "Keep plugins enabled when updating").
 */

/** A plugin that can't be installed, with a message meant for people. */
export class PluginInstallError extends Error {}

function fail(message: string): never {
  throw new PluginInstallError(message)
}

export interface InstallResult {
  plugin: InstalledPlugin
  /** An existing plugin with this id was replaced. */
  replaced: boolean
  /** The code is identical to what was installed (it stays enabled if it was). */
  sameCode: boolean
  /** The new version replaced a running one and was started again. */
  restarted: boolean
}

export async function installFromArchive(fileName: string, bytes: Uint8Array): Promise<InstallResult> {
  let archive: PluginArchive
  try {
    archive = readPluginArchive(fileName, bytes)
  } catch (error) {
    if (error instanceof PluginArchiveError) fail(error.message)
    throw error
  }

  const { manifest: metadata } = archive
  if (metadata.side === 'server') fail(`${metadata.name} is a server plugin. Install it on a Noctis server instead.`)
  if (!supportsPlatform(metadata, platform)) fail(`${metadata.name} doesn't run here: it's made for ${describePlatforms(metadata)}.`)
  // "both" plugins bring their client half; the server half is the server's business.
  const code = archive.client ?? ''
  const hash = await sha256Hex(code)

  const { id } = archive
  const existing = findPlugin(id)
  const sameCode = existing?.sha256 === hash
  // New code for an installed plugin: stop the old one. It runs again if it was on and the
  // setting allows; otherwise the new code needs approving like any other.
  const wasEnabled = existing ? isEnabled(existing) : false
  if (existing && !sameCode && isRunning(existing)) await disablePlugin(existing)

  // Nothing installed under this id: whatever consent is left over from an earlier install
  // (before removal forgot it) doesn't carry over to this one.
  if (!existing) forgetPluginConsent(hash)

  const plugin: InstalledPlugin = { id, code, sha256: hash, metadata, installedAt: Date.now() }
  installedPlugins.value = existing
    ? installedPlugins.value.map((item) => (item.id === id ? plugin : item))
    : [...installedPlugins.value, plugin]

  let restarted = false
  if (existing && !sameCode) {
    // The old code is gone: its consent goes with it, unless the new code inherits it below.
    forgetPluginConsent(existing.sha256)
    if (wasEnabled && keepEnabledOnUpdate.value) {
      approvedHashes.value = { ...approvedHashes.value, [hash]: true }
      restarted = await enablePlugin(plugin)
      if (!restarted) writeLog(id, 'warn', 'The new version failed to start; see its log')
    }
  }

  writeLog('noctis', 'info', `${existing ? 'Updated' : 'Installed'} ${id} ${metadata.version} (sha256 ${hash.slice(0, 12)}…)${restarted ? ', started' : ''}`)
  if (existing && !sameCode) forgetStreams()
  return { plugin, replaced: Boolean(existing), sameCode, restarted }
}

export async function installFromFile(file: File): Promise<InstallResult> {
  return installFromArchive(file.name, new Uint8Array(await file.arrayBuffer()))
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Hosts on this machine or this network, where a development server runs and plain http is fine. */
function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]'
  )
}

/** Plugins come over https; plain http only from this machine or network (a development server). */
export function checkPluginUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    fail("That isn't a valid URL")
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) {
    fail('Plugins can only be downloaded over https (http works for addresses on your own network)')
  }
  return parsed
}

/** Download a file as bytes: native HTTP on a device (no CORS), fetch in the browser. */
export async function downloadBytes(url: string): Promise<Uint8Array> {
  if (isNative) {
    const response = await CapacitorHttp.request({ url, method: 'GET', responseType: 'arraybuffer' })
    if (response.status < 200 || response.status >= 300) fail(`Download failed (HTTP ${response.status})`)
    return base64ToBytes(String(response.data))
  }
  // Never a stale copy: a development server answers with a new build under the same address.
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) fail(`Download failed (HTTP ${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function installFromUrl(url: string): Promise<InstallResult> {
  const parsed = checkPluginUrl(url)
  const bytes = await downloadBytes(parsed.href)
  const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || 'plugin.zip')
  return installFromArchive(fileName, bytes)
}

/** Open the system file picker for a plugin archive. */
export function pickPluginFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,.noctis,application/zip,application/octet-stream'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}
