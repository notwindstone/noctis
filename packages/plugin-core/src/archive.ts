import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { isValidPluginId, ManifestError, parseManifest, runsOnClient, runsOnServer, type PluginManifest } from './manifest'

/**
 * Plugin archives: a ZIP (`.noctis` or `.zip`) with metadata.json plus index.js (the
 * client half) and/or server.js (the server half), at the root or inside one top-level
 * folder. The file name, minus the extension, is the plugin id.
 */

export const MANIFEST_FILE = 'metadata.json'
export const CLIENT_ENTRY = 'index.js'
export const SERVER_ENTRY = 'server.js'

/** Archives bigger than this are refused before unzipping. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

export interface PluginArchive {
  id: string
  manifest: PluginManifest
  /** index.js, for plugins that run on the client. */
  client?: string
  /** server.js, for plugins that run on the server. */
  server?: string
}

export class PluginArchiveError extends Error {
  override name = 'PluginArchiveError'
}

function fail(message: string): never {
  throw new PluginArchiveError(message)
}

export function idFromFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const id = base.replace(/\.(zip|noctis)$/i, '').trim().toLowerCase()
  if (!isValidPluginId(id)) {
    fail(`"${base}" isn't a valid plugin file name. Use letters, digits, ".", "_" or "-" (it becomes the plugin id).`)
  }
  return id
}

/** A file at the archive root, or inside its only top-level folder. */
function pick(files: Record<string, Uint8Array>, name: string): Uint8Array | undefined {
  if (files[name]) return files[name]
  const nested = Object.keys(files).filter((path) => path.endsWith(`/${name}`) && path.split('/').length === 2)
  return nested.length === 1 ? files[nested[0]] : undefined
}

const WANTED = new Set([MANIFEST_FILE, CLIENT_ENTRY, SERVER_ENTRY])

export function readPluginArchive(fileName: string, bytes: Uint8Array): PluginArchive {
  const id = idFromFileName(fileName)
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`)

  let files: Record<string, Uint8Array>
  try {
    // Only inflate the files a plugin can have; anything else in the archive is ignored.
    files = unzipSync(bytes, { filter: (file) => WANTED.has(file.name.split('/').pop() ?? '') && file.name.split('/').length <= 2 })
  } catch {
    fail("This file isn't a valid ZIP archive")
  }

  const metadataFile = pick(files, MANIFEST_FILE)
  if (!metadataFile) fail('The archive has no metadata.json')
  let json: unknown
  try {
    json = JSON.parse(strFromU8(metadataFile))
  } catch {
    fail("metadata.json isn't valid JSON")
  }

  let manifest: PluginManifest
  try {
    manifest = parseManifest(json)
  } catch (error) {
    if (error instanceof ManifestError) fail(error.message)
    throw error
  }

  const clientFile = pick(files, CLIENT_ENTRY)
  const serverFile = pick(files, SERVER_ENTRY)
  if (runsOnClient(manifest) && !clientFile) fail(`A "${manifest.side}" plugin needs ${CLIENT_ENTRY}`)
  if (runsOnServer(manifest) && !serverFile) fail(`A "${manifest.side}" plugin needs ${SERVER_ENTRY}`)

  return {
    id,
    manifest,
    client: runsOnClient(manifest) && clientFile ? strFromU8(clientFile) : undefined,
    server: runsOnServer(manifest) && serverFile ? strFromU8(serverFile) : undefined,
  }
}

/** The manifest as written to an archive (defaults filled in, nothing undefined). */
export function serializeManifest(manifest: PluginManifest): string {
  return JSON.stringify(manifest, (_key, value) => (value === undefined ? undefined : value), 2)
}

export function writePluginArchive(parts: { manifest: PluginManifest; client?: string; server?: string }): Uint8Array {
  const files: Record<string, Uint8Array> = { [MANIFEST_FILE]: strToU8(serializeManifest(parts.manifest)) }
  if (parts.client !== undefined) files[CLIENT_ENTRY] = strToU8(parts.client)
  if (parts.server !== undefined) files[SERVER_ENTRY] = strToU8(parts.server)
  return zipSync(files, { level: 9 })
}

/**
 * The client half of a "both" plugin as a client-only archive, which is what a server
 * hands out to clients: its manifest says "client", so the client never sees server code.
 */
export function clientArchiveOf(archive: PluginArchive): Uint8Array {
  if (archive.client === undefined) fail(`${archive.id} has no client half`)
  const { client: _requirement, ...rest } = archive.manifest
  return writePluginArchive({ manifest: { ...rest, side: 'client' }, client: archive.client })
}
