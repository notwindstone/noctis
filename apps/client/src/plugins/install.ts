import { CapacitorHttp } from '@capacitor/core'
import { describePlatforms, PluginArchiveError, readPluginArchive, sha256Hex, supportsPlatform, type PluginArchive } from '@noctis/plugin-core'
import { isNative, platform } from '../native'
import { writeLog } from './log'
import { disablePlugin, isRunning } from './runtime'
import { findPlugin, forgetPluginConsent, installedPlugins, type InstalledPlugin } from './store'

/**
 * Installing plugins from archives (read and validated by @noctis/plugin-core): a
 * `.zip` / `.noctis` file with metadata.json and index.js. The archive's file name,
 * minus the extension, is the plugin id. Server plugins are refused, and so are plugins
 * whose `platforms` don't include this app; plugins for both sides install their client half.
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
}

export async function installFromArchive(fileName: string, bytes: Uint8Array): Promise<InstallResult> {
  let archive: PluginArchive
  try {
    archive = readPluginArchive(fileName, bytes)
  } catch (error) {
    if (error instanceof PluginArchiveError) fail(error.message)
    throw error
  }

  const { id, manifest: metadata } = archive
  if (metadata.side === 'server') fail(`${metadata.name} is a server plugin. Install it on a Noctis server instead.`)
  if (!supportsPlatform(metadata, platform)) fail(`${metadata.name} doesn't run here: it's made for ${describePlatforms(metadata)}.`)
  // "both" plugins bring their client half; the server half is the server's business.
  const code = archive.client ?? ''
  const hash = await sha256Hex(code)

  const existing = findPlugin(id)
  const sameCode = existing?.sha256 === hash
  // New code under the same id: stop the old one; the new code needs approving again.
  if (existing && !sameCode && isRunning(existing)) await disablePlugin(existing)

  // Nothing installed under this id: whatever consent is left over from an earlier install
  // (before removal forgot it) doesn't carry over to this one.
  if (!existing) forgetPluginConsent(hash)

  const plugin: InstalledPlugin = { id, code, sha256: hash, metadata, installedAt: Date.now() }
  installedPlugins.value = existing
    ? installedPlugins.value.map((item) => (item.id === id ? plugin : item))
    : [...installedPlugins.value, plugin]

  writeLog('noctis', 'info', `Installed ${id} ${metadata.version} (sha256 ${hash.slice(0, 12)}…)`)
  return { plugin, replaced: Boolean(existing), sameCode }
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

/** Download a file as bytes: native HTTP on a device (no CORS), fetch in the browser. */
export async function downloadBytes(url: string): Promise<Uint8Array> {
  if (isNative) {
    const response = await CapacitorHttp.request({ url, method: 'GET', responseType: 'arraybuffer' })
    if (response.status < 200 || response.status >= 300) fail(`Download failed (HTTP ${response.status})`)
    return base64ToBytes(String(response.data))
  }
  const response = await fetch(url)
  if (!response.ok) fail(`Download failed (HTTP ${response.status})`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function installFromUrl(url: string): Promise<InstallResult> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    fail("That isn't a valid URL")
  }
  if (parsed.protocol !== 'https:') fail('Plugins can only be downloaded over https')

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
