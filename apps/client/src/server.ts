import {
  encodePluginsHeader,
  PLUGINS_HEADER,
  readPluginArchive,
  sha256Hex,
  type ClientPlugin,
  type ClientPluginRequirement,
  type HandshakeResponse,
} from '@noctis/plugin-core'
import { computed, ref, shallowRef } from 'vue'
import { request as httpRequest, type HttpResponse } from './http'
import { downloadBytes, installFromArchive, PluginInstallError, type InstallResult } from './plugins/install'
import { writeLog } from './plugins/log'
import { isRunning } from './plugins/runtime'
import { installedPlugins, isEnabled } from './plugins/store'
import { persisted } from './storage'

/**
 * The connection to a Noctis server (apps/server).
 *
 * Every request says which plugins this client runs (`x-noctis-plugins`). A server can
 * require client plugins, like a Minecraft server requiring mods: until they're
 * installed it answers 428 with a handshake listing them, and this module downloads
 * them from the server, checks their hashes and installs them.
 */

export const serverUrl = persisted<string>('noctis:server-url', '', (value) => typeof value === 'string')

export type ServerStatus = 'none' | 'connecting' | 'connected' | 'needs-plugins' | 'error'

export const serverStatus = ref<ServerStatus>(serverUrl.value ? 'connecting' : 'none')
export const serverError = ref('')
/** The last handshake: server info, and the client plugins it wants. */
export const handshake = shallowRef<HandshakeResponse | null>(null)

/** Required plugins this client doesn't have (or has in the wrong version). */
export const missingPlugins = computed<ClientPluginRequirement[]>(() => {
  const result = handshake.value?.result
  return result ? [...result.missing, ...result.outdated.map((item) => item.requirement)] : []
})

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Plugins this client runs, as the server sees them. */
export function clientPlugins(): ClientPlugin[] {
  return installedPlugins.value
    .filter((plugin) => isEnabled(plugin) && isRunning(plugin))
    .map((plugin) => ({ id: plugin.id, version: plugin.metadata.version || '0.0.0' }))
}

/** localhost, *.local and private IPv4 ranges: servers there rarely have TLS. */
const LOCAL_HOST = /^(localhost|[^/:]+\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/|$)/i

function normalize(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  // Without a scheme: http for local addresses, https for everything else.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${LOCAL_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new ServerError("That isn't a valid server address", 0)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ServerError('Use an http or https address', 0)
  return parsed.href.replace(/\/+$/, '')
}

/**
 * Call the server: `path` is absolute ("/api/plugins/play-stats/top"). Throws
 * ServerError on failure; a 428 also updates `handshake` with what's missing.
 */
export async function serverRequest<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!serverUrl.value) throw new ServerError('Not connected to a Noctis server', 0)
  let response: HttpResponse
  try {
    response = await httpRequest(`${serverUrl.value}${path}`, {
      method: init.method,
      body: init.body,
      headers: { [PLUGINS_HEADER]: encodePluginsHeader(clientPlugins()), accept: 'application/json' },
    })
  } catch (error) {
    throw new ServerError(`Couldn't reach the server: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  if (response.status === 428) {
    handshake.value = response.data as HandshakeResponse
    serverStatus.value = 'needs-plugins'
    throw new ServerError('The server needs plugins this client doesn\'t have', 428)
  }
  if (response.status < 200 || response.status >= 300) {
    const message = (response.data as { error?: string; detail?: string } | null)?.error ?? (response.data as { detail?: string } | null)?.detail
    throw new ServerError(message || `The server answered HTTP ${response.status}`, response.status)
  }
  return response.data as T
}

/** Check in with the server (and remember it). Resolves to the handshake. */
export async function connect(url = serverUrl.value): Promise<HandshakeResponse> {
  serverStatus.value = 'connecting'
  serverError.value = ''
  try {
    const base = normalize(url)
    serverUrl.value = base
    const response = await serverRequest<HandshakeResponse>('/api/v1/handshake')
    if (typeof response?.protocol !== 'number' || !response.result) throw new ServerError("That doesn't look like a Noctis server", 0)
    handshake.value = response
    serverStatus.value = response.result.ok ? 'connected' : 'needs-plugins'
    writeLog('noctis', 'info', `Connected to ${response.server.name} ${response.server.version} at ${base}${response.result.ok ? '' : ` (needs ${missingPlugins.value.map((item) => item.id).join(', ')})`}`)
    return response
  } catch (error) {
    serverStatus.value = 'error'
    serverError.value = error instanceof Error ? error.message : String(error)
    throw error
  }
}

export function disconnect() {
  serverUrl.value = ''
  handshake.value = null
  serverStatus.value = 'none'
  serverError.value = ''
}

/**
 * Download a client plugin from the server and install it, after checking it's the
 * code the server announced (its index.js hash). Enabling it is up to the caller.
 */
export async function installFromServer(requirement: ClientPluginRequirement): Promise<InstallResult> {
  const bytes = await downloadBytes(`${serverUrl.value}${requirement.download}`)
  const archive = readPluginArchive(`${requirement.id}.noctis`, bytes)
  if ((await sha256Hex(archive.client ?? '')) !== requirement.sha256) {
    throw new PluginInstallError(`${requirement.name} from the server doesn't match what the server announced; not installing it`)
  }
  return installFromArchive(`${requirement.id}.noctis`, bytes)
}
