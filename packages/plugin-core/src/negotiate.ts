import type { PluginManifest } from './manifest'
import { isValidPluginId, supportsPlatform } from './manifest'
import { isValidVersion, satisfies } from './semver'

/**
 * Client–server negotiation, like a Minecraft server checking a client's mods.
 *
 * A server lists the client plugins it wants (the client halves of its "both"
 * plugins). A client says which plugins it runs in the `x-noctis-plugins` header on
 * every request ("id@version,id@version"), and which platform it is in
 * `x-noctis-platform`. The server refuses requests from clients that lack a required
 * plugin, or have a version outside the accepted range, and says what to install and
 * where to get it. A plugin that doesn't run on the client's platform isn't required.
 */

export const PLUGINS_HEADER = 'x-noctis-plugins'
/** Which app the client is ("android", "web"…): plugins for other platforms aren't required of it. */
export const PLATFORM_HEADER = 'x-noctis-platform'

/** Bumped when the negotiation format changes. */
export const PROTOCOL_VERSION = 1

export interface ClientPluginRequirement {
  id: string
  name: string
  /** The server's version of the plugin. */
  version: string
  /** Client versions accepted. */
  versions: string
  /** Without it the client can't use the server; otherwise it's a suggestion. */
  required: boolean
  /** SHA-256 of the client half's index.js, to verify the download. */
  sha256: string
  /** Where to download the client half as a .noctis archive (relative to the server). */
  download: string
  /** Platforms the client half runs on (["*"]: all). Absent from older servers. */
  platforms?: string[]
}

export interface ClientPlugin {
  id: string
  version: string
}

export interface NegotiationResult {
  /** Every required plugin is present in an accepted version. */
  ok: boolean
  missing: ClientPluginRequirement[]
  outdated: { requirement: ClientPluginRequirement; installed: string }[]
  /** Optional plugins the client doesn't have. */
  suggested: ClientPluginRequirement[]
  /** Plugins that don't run on the client's platform, so aren't required of it. Absent from older servers. */
  unsupported?: ClientPluginRequirement[]
}

export function requirementFor(
  id: string,
  manifest: Pick<PluginManifest, 'name' | 'version' | 'side' | 'client'> & { platforms?: string[] },
  sha256: string,
  download: string,
): ClientPluginRequirement | null {
  if (manifest.side !== 'both' || !manifest.client) return null
  return { id, name: manifest.name, version: manifest.version, versions: manifest.client.versions, required: manifest.client.required, sha256, download, platforms: manifest.platforms ?? ['*'] }
}

/** `platform`: the client's, from PLATFORM_HEADER; unknown (older clients) requires everything. */
export function checkClientPlugins(requirements: ClientPluginRequirement[], installed: ClientPlugin[], platform?: string | null): NegotiationResult {
  const versions = new Map(installed.map((plugin) => [plugin.id, plugin.version]))
  const result: NegotiationResult = { ok: true, missing: [], outdated: [], suggested: [], unsupported: [] }
  for (const requirement of requirements) {
    const version = versions.get(requirement.id)
    if (platform && version === undefined && !supportsPlatform(requirement, platform)) {
      result.unsupported!.push(requirement)
      continue
    }
    if (version === undefined) {
      if (requirement.required) result.missing.push(requirement)
      else result.suggested.push(requirement)
    } else if (!satisfies(version, requirement.versions)) {
      if (requirement.required) result.outdated.push({ requirement, installed: version })
      else result.suggested.push(requirement)
    }
  }
  result.ok = result.missing.length === 0 && result.outdated.length === 0
  return result
}

export function encodePluginsHeader(plugins: ClientPlugin[]): string {
  return plugins.map((plugin) => `${plugin.id}@${plugin.version || '0.0.0'}`).join(',')
}

/** Parse the header; malformed entries are dropped. At most 200 entries. */
export function decodePluginsHeader(header: string | null | undefined): ClientPlugin[] {
  if (!header) return []
  const plugins: ClientPlugin[] = []
  for (const part of header.split(',').slice(0, 200)) {
    const at = part.lastIndexOf('@')
    if (at <= 0) continue
    const id = part.slice(0, at).trim()
    const version = part.slice(at + 1).trim()
    if (isValidPluginId(id) && isValidVersion(version)) plugins.push({ id, version })
  }
  return plugins
}

/** What GET /noctis/v1/handshake and failed requests answer with. */
export interface HandshakeResponse {
  protocol: number
  server: { name: string; version: string }
  /** Client plugins this server wants. */
  plugins: ClientPluginRequirement[]
  result: NegotiationResult
}
