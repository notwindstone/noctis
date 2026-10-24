import { CapacitorHttp } from '@capacitor/core'
import { strFromU8, unzipSync } from 'fflate'
import { isNative } from '../native'
import { writeLog } from './log'
import { disablePlugin, isRunning } from './runtime'
import { findPlugin, installedPlugins, type InstalledPlugin, type PluginMetadata } from './store'

/**
 * Installing plugins from archives: a `.zip` / `.noctis` file holding `index.js` and
 * `metadata.json` (at the root, or inside a single top-level folder). The archive's file
 * name, minus the extension, is the plugin id.
 */

export class PluginInstallError extends Error {}

function fail(message: string): never {
  throw new PluginInstallError(message)
}

function idFromFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const id = base.replace(/\.(zip|noctis)$/i, '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    fail(`"${base}" isn't a valid plugin file name. Use letters, digits, ".", "_" or "-" (it becomes the plugin id).`)
  }
  return id
}

const isStringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string')

function validateMetadata(value: unknown): PluginMetadata {
  if (typeof value !== 'object' || value === null) fail('metadata.json must contain an object')
  const data = value as Record<string, unknown>

  if (typeof data.name !== 'string' || !data.name.trim()) fail('metadata.json needs a "name"')
  if (data.type === 'sandbox') fail('Sandboxed plugins aren\'t supported yet; use "type": "unrestricted"')
  if (data.type !== 'unrestricted') fail('metadata.json "type" must be "unrestricted"')
  if (data.version !== undefined && typeof data.version !== 'string') fail('"version" must be a string')
  if (data.authors !== undefined && !isStringArray(data.authors)) fail('"authors" must be an array of strings')
  if (data.description !== undefined && typeof data.description !== 'string') fail('"description" must be a string')
  if (data.logo !== undefined && (typeof data.logo !== 'string' || !/^(https:|data:image\/)/.test(data.logo || 'https:'))) {
    fail('"logo" must be an https: or data:image/ URL')
  }
  if (data.source !== undefined && typeof data.source !== 'string') fail('"source" must be a string')

  return {
    name: data.name.trim().slice(0, 80),
    version: (data.version as string | undefined) ?? '',
    authors: (data.authors as string[] | undefined) ?? [],
    type: 'unrestricted',
    description: data.description as string | undefined,
    logo: (data.logo as string | undefined) || undefined,
    source: (data.source as string | undefined) || undefined,
    categories: isStringArray(data.categories) ? (data.categories as string[]) : undefined,
    languages: isStringArray(data.languages) ? (data.languages as string[]) : undefined,
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Find a file at the archive root or inside its only top-level folder. */
function pick(files: Record<string, Uint8Array>, name: string): Uint8Array | undefined {
  if (files[name]) return files[name]
  const nested = Object.keys(files).filter((path) => path.endsWith(`/${name}`) && path.split('/').length === 2)
  return nested.length === 1 ? files[nested[0]] : undefined
}

export interface InstallResult {
  plugin: InstalledPlugin
  /** An existing plugin with this id was replaced. */
  replaced: boolean
  /** The code is identical to what was installed (it stays enabled if it was). */
  sameCode: boolean
}

export async function installFromArchive(fileName: string, bytes: Uint8Array): Promise<InstallResult> {
  const id = idFromFileName(fileName)

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    fail("This file isn't a valid ZIP archive")
  }

  const codeFile = pick(files, 'index.js')
  const metadataFile = pick(files, 'metadata.json')
  if (!codeFile) fail('The archive has no index.js')
  if (!metadataFile) fail('The archive has no metadata.json')

  let metadataJson: unknown
  try {
    metadataJson = JSON.parse(strFromU8(metadataFile))
  } catch {
    fail("metadata.json isn't valid JSON")
  }

  const metadata = validateMetadata(metadataJson)
  const code = strFromU8(codeFile)
  const hash = await sha256(code)

  const existing = findPlugin(id)
  const sameCode = existing?.sha256 === hash
  // New code under the same id: stop the old one; the new code needs approving again.
  if (existing && !sameCode && isRunning(existing)) await disablePlugin(existing)

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

export async function installFromUrl(url: string): Promise<InstallResult> {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    fail("That isn't a valid URL")
  }
  if (parsed.protocol !== 'https:') fail('Plugins can only be downloaded over https')

  let bytes: Uint8Array
  if (isNative) {
    const response = await CapacitorHttp.request({ url: parsed.href, method: 'GET', responseType: 'arraybuffer' })
    if (response.status < 200 || response.status >= 300) fail(`Download failed (HTTP ${response.status})`)
    bytes = base64ToBytes(String(response.data))
  } else {
    const response = await fetch(parsed.href)
    if (!response.ok) fail(`Download failed (HTTP ${response.status})`)
    bytes = new Uint8Array(await response.arrayBuffer())
  }

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
