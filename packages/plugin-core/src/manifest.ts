import { isValidRange, isValidVersion } from './semver'

/**
 * metadata.json: what a plugin is, where it runs, and what it needs.
 *
 * `side` says where the code runs, like environments for Minecraft mods:
 * - "client" (the default): index.js runs in the app.
 * - "server": server.js runs on a Noctis server; clients never see it.
 * - "both": both halves. Clients connecting to a server that has it must have the
 *   client half installed, unless `client.required` is false.
 *
 * `platforms` says which apps the client half runs in: "android", "ios", "web",
 * "desktop", or "*" for all of them (the default). Clients refuse to install a plugin
 * for another platform, and servers don't require it from clients it can't run on.
 */

export type PluginSide = 'client' | 'server' | 'both'

/** The apps a client plugin can run in. Others may be added; unknown names are kept. */
export const PLUGIN_PLATFORMS = ['android', 'ios', 'web', 'desktop'] as const
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number]
/** Every platform, including ones that don't exist yet. */
export const ALL_PLATFORMS = '*'

/**
 * Version of the plugin API (`Noctis` and `Plugin` as plugins see them). Plugins can ask for
 * a range of it in `requires.api`. Bump the minor for additions, the major for breaking changes.
 */
export const PLUGIN_API_VERSION = '1.0.0'

/** What a plugin needs from the app it runs in, besides other plugins. */
export interface PluginRequirements {
  /** Range of PLUGIN_API_VERSION the plugin was written for. */
  api?: string
  /** Names under `Noctis.libs` it uses, e.g. ["notifications", "offline"]. A client without one doesn't start it. */
  libs: string[]
}

export interface PluginManifest {
  /** The plugin's id, so it stays the same whatever the archive is called (file hosts rename files). Default: the archive's file name. */
  id?: string
  name: string
  /** Only "unrestricted" for now: no sandbox. */
  type: 'unrestricted'
  /** Semver. Required for server and both-sides plugins; may be "" for older client plugins. */
  version: string
  side: PluginSide
  authors: string[]
  description?: string
  /**
   * The plugin's icon: an https: or data:image/ URL, or an image file in the archive
   * ("icon.png", up to 256 KB; Noctis inlines it when it reads the archive).
   */
  logo?: string
  /** Where the source lives, e.g. a repository URL. */
  source?: string
  categories?: string[]
  /** ISO 639-1 codes. */
  languages?: string[]
  /** Plugin id → semver range. Checked on each side the plugin runs on. */
  dependencies: Record<string, string>
  /** Plugin id → semver range ("*": any version) it can't run alongside. Either plugin may say so; the one installed later doesn't start. */
  incompatible: Record<string, string>
  /** What it needs from the app. */
  requires: PluginRequirements
  /** Where the client half runs: platform names, or ["*"] (the default) for everywhere. */
  platforms: string[]
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

/** Image files a logo may point at inside an archive. */
export const LOGO_FILE = /^[\w][\w. -]{0,63}\.(png|jpe?g|webp|gif|svg)$/i
export const MAX_LOGO_BYTES = 256 * 1024

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
  if (data.id !== undefined && (typeof data.id !== 'string' || !isValidPluginId(data.id))) fail('"id" must be a plugin id: lowercase letters, digits, ".", "_" or "-"')
  if (data.type === 'sandbox') fail('Sandboxed plugins aren\'t supported yet; use "type": "unrestricted"')
  if (data.type !== 'unrestricted') fail('metadata.json "type" must be "unrestricted"')

  const side = data.side ?? 'client'
  if (side !== 'client' && side !== 'server' && side !== 'both') fail('"side" must be "client", "server" or "both"')

  if (data.version !== undefined && typeof data.version !== 'string') fail('"version" must be a string')
  const version = (data.version as string | undefined)?.trim() ?? ''
  if (side !== 'client' && !isValidVersion(version)) fail(`"${side}" plugins need a semver "version", like "1.0.0"`)

  if (data.authors !== undefined && !isStringArray(data.authors)) fail('"authors" must be an array of strings')
  if (data.description !== undefined && typeof data.description !== 'string') fail('"description" must be a string')
  if (data.logo !== undefined && (typeof data.logo !== 'string' || !/^(https:|data:image\/)/.test(data.logo || 'https:') && !LOGO_FILE.test(data.logo))) {
    fail('"logo" must be an https: or data:image/ URL, or an image file in the archive like "icon.png"')
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

  const incompatible: Record<string, string> = {}
  if (data.incompatible !== undefined) {
    // A list of ids is shorthand for "any version of these".
    const raw = isStringArray(data.incompatible) ? Object.fromEntries(data.incompatible.map((id) => [id, '*'])) : data.incompatible
    if (!isRecord(raw)) fail('"incompatible" must be a list of plugin ids, or map them to version ranges')
    for (const [id, range] of Object.entries(raw)) {
      if (!isValidPluginId(id)) fail(`"${id}" in "incompatible" isn't a valid plugin id`)
      if (typeof range !== 'string' || !isValidRange(range)) fail(`"${range}" isn't a valid version range for "${id}" in "incompatible"`)
      incompatible[id] = range
    }
  }

  const requires: PluginRequirements = { libs: [] }
  if (data.requires !== undefined) {
    if (!isRecord(data.requires)) fail('"requires" must be an object like { "api": "^1.0.0", "libs": ["offline"] }')
    const { api, libs } = data.requires
    if (api !== undefined) {
      if (typeof api !== 'string' || !isValidRange(api)) fail('"requires.api" must be a version range')
      requires.api = api
    }
    if (libs !== undefined) {
      if (!isStringArray(libs)) fail('"requires.libs" must be an array of names under Noctis.libs')
      requires.libs = [...new Set(libs)]
    }
  }

  let platforms = [ALL_PLATFORMS]
  if (data.platforms !== undefined) {
    // "*" on its own is fine too.
    const raw = typeof data.platforms === 'string' ? [data.platforms] : data.platforms
    if (!isStringArray(raw) || raw.length === 0) fail('"platforms" must be a list like ["android", "web"], or "*"')
    const names = [...new Set(raw.map((name) => name.trim().toLowerCase()))]
    for (const name of names) {
      if (name !== ALL_PLATFORMS && !/^[a-z][a-z0-9-]{0,31}$/.test(name)) fail(`"${name}" in "platforms" isn't a platform name (${PLUGIN_PLATFORMS.join(', ')} or "*")`)
    }
    platforms = names.includes(ALL_PLATFORMS) ? [ALL_PLATFORMS] : names
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
    id: data.id as string | undefined,
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
    incompatible,
    requires,
    platforms,
    client,
  }
}

/** Whether a plugin's client half runs on `platform`. Older manifests without the field run everywhere. */
export function supportsPlatform(manifest: { platforms?: string[] }, platform: string): boolean {
  const platforms = manifest.platforms ?? [ALL_PLATFORMS]
  return platforms.includes(ALL_PLATFORMS) || platforms.includes(platform)
}

/** "Android and web", "every platform". */
export function describePlatforms(manifest: { platforms?: string[] }): string {
  const platforms = manifest.platforms ?? [ALL_PLATFORMS]
  if (platforms.includes(ALL_PLATFORMS)) return 'Every platform'
  const names = platforms.map((name) => ({ android: 'Android', ios: 'iOS', web: 'Web', desktop: 'Desktop' })[name] ?? name)
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export const runsOnClient = (manifest: Pick<PluginManifest, 'side'>) => manifest.side !== 'server'
export const runsOnServer = (manifest: Pick<PluginManifest, 'side'>) => manifest.side !== 'client'
