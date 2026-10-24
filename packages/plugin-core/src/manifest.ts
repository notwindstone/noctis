import { isValidRange, isValidVersion } from './semver'

/**
 * metadata.json: what a plugin is, where it runs, and what it needs.
 *
 * `side` says where the code runs, like environments for Minecraft mods:
 * - "client" (the default): index.js runs in the app.
 * - "server": server.js runs on a Noctis server; clients never see it.
 * - "both": both halves. Clients connecting to a server that has it must have the
 *   client half installed, unless `client.required` is false.
 */

export type PluginSide = 'client' | 'server' | 'both'

export interface PluginManifest {
  name: string
  /** Only "unrestricted" for now: no sandbox. */
  type: 'unrestricted'
  /** Semver. Required for server and both-sides plugins; may be "" for older client plugins. */
  version: string
  side: PluginSide
  authors: string[]
  description?: string
  /** https: or data:image/ URL. */
  logo?: string
  /** Where the source lives, e.g. a repository URL. */
  source?: string
  categories?: string[]
  /** ISO 639-1 codes. */
  languages?: string[]
  /** Plugin id → semver range. Checked on each side the plugin runs on. */
  dependencies: Record<string, string>
  /** For "both" plugins: what the server asks of connecting clients. */
  client?: ClientRequirement
}

export interface ClientRequirement {
  /** Clients without the client half can't use the server. Default true. */
  required: boolean
  /** Client-half versions the server accepts. Default "^<version>". */
  versions: string
}

/** Plugin ids: also archive file names and URL segments. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID.test(id)
}

export class ManifestError extends Error {
  override name = 'ManifestError'
}

function fail(message: string): never {
  throw new ManifestError(message)
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate parsed metadata.json. Throws ManifestError with a message meant for people. */
export function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) fail('metadata.json must contain an object')
  const data = value

  if (typeof data.name !== 'string' || !data.name.trim()) fail('metadata.json needs a "name"')
  if (data.type === 'sandbox') fail('Sandboxed plugins aren\'t supported yet; use "type": "unrestricted"')
  if (data.type !== 'unrestricted') fail('metadata.json "type" must be "unrestricted"')

  const side = data.side ?? 'client'
  if (side !== 'client' && side !== 'server' && side !== 'both') fail('"side" must be "client", "server" or "both"')

  if (data.version !== undefined && typeof data.version !== 'string') fail('"version" must be a string')
  const version = (data.version as string | undefined)?.trim() ?? ''
  if (side !== 'client' && !isValidVersion(version)) fail(`"${side}" plugins need a semver "version", like "1.0.0"`)

  if (data.authors !== undefined && !isStringArray(data.authors)) fail('"authors" must be an array of strings')
  if (data.description !== undefined && typeof data.description !== 'string') fail('"description" must be a string')
  if (data.logo !== undefined && (typeof data.logo !== 'string' || !/^(https:|data:image\/)/.test(data.logo || 'https:'))) {
    fail('"logo" must be an https: or data:image/ URL')
  }
  if (data.source !== undefined && typeof data.source !== 'string') fail('"source" must be a string')

  const dependencies: Record<string, string> = {}
  if (data.dependencies !== undefined) {
    if (!isRecord(data.dependencies)) fail('"dependencies" must map plugin ids to version ranges')
    for (const [id, range] of Object.entries(data.dependencies)) {
      if (!isValidPluginId(id)) fail(`"${id}" in "dependencies" isn't a valid plugin id`)
      if (typeof range !== 'string' || !isValidRange(range)) fail(`"${range}" isn't a valid version range for dependency "${id}"`)
      dependencies[id] = range
    }
  }

  let client: ClientRequirement | undefined
  if (data.client !== undefined && side !== 'both') fail('"client" only applies to plugins with "side": "both"')
  if (side === 'both') {
    const raw = data.client ?? {}
    if (!isRecord(raw)) fail('"client" must be an object')
    if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('"client.required" must be true or false')
    if (raw.versions !== undefined && (typeof raw.versions !== 'string' || !isValidRange(raw.versions))) {
      fail('"client.versions" must be a version range')
    }
    client = {
      required: (raw.required as boolean | undefined) ?? true,
      versions: (raw.versions as string | undefined) ?? `^${version}`,
    }
  }

  return {
    name: data.name.trim().slice(0, 80),
    type: 'unrestricted',
    version,
    side,
    authors: (data.authors as string[] | undefined) ?? [],
    description: data.description as string | undefined,
    logo: (data.logo as string | undefined) || undefined,
    source: (data.source as string | undefined) || undefined,
    categories: isStringArray(data.categories) ? data.categories : undefined,
    languages: isStringArray(data.languages) ? data.languages : undefined,
    dependencies,
    client,
  }
}

export const runsOnClient = (manifest: Pick<PluginManifest, 'side'>) => manifest.side !== 'server'
export const runsOnServer = (manifest: Pick<PluginManifest, 'side'>) => manifest.side !== 'client'
