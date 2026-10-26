import {
  encodePluginsHeader,
  PLATFORM_HEADER,
  PLUGINS_HEADER,
  readPluginArchive,
  sha256Hex,
  type ClientPlugin,
  type ClientPluginRequirement,
  type HandshakeResponse,
} from '@noctis/plugin-core'
import { computed, ref, shallowRef } from 'vue'
import { request as httpRequest, type HttpResponse } from './http'
import { platform } from './native'
import { canUseServer, credentials, guestAccess, hasExtension, subsonic, tokenCredentials } from './subsonic/client'
import { attachServerService, detachServerService } from './subsonic/service'
import { downloadBytes, installFromArchive, PluginInstallError, type InstallResult } from './plugins/install'
import { writeLog } from './plugins/log'
import { runStates } from './plugins/runtime'
import { installedPlugins } from './plugins/store'
import { persisted } from './storage'

/**
 * The connection to a server: a Noctis server (apps/server), or any OpenSubsonic
 * server (Navidrome, Gonic…), which gets the same library features without Noctis's
 * extras.
 *
 * Every request to a Noctis server says which plugins this client runs
 * (`x-noctis-plugins`). A server can require client plugins, like a Minecraft server
 * requiring mods: until they're installed it answers 428 with a handshake listing them,
 * and this module downloads them from the server, checks their hashes and installs them.
 * Plugins that don't run on this platform (`x-noctis-platform`) aren't required of it.
 *
 * Signed in, the server becomes a service (src/subsonic/service.ts). Servers with guest
 * access (`/noctis/v1/info`) are a service without signing in; signing in is optional.
 */

export const serverUrl = persisted<string>('noctis:server-url', '', (value) => typeof value === 'string')

export type ServerStatus = 'none' | 'connecting' | 'connected' | 'needs-plugins' | 'error'

/** "noctis": /noctis/v1 and /rest; "opensubsonic": /rest only. */
export const serverKind = persisted<'noctis' | 'opensubsonic' | null>('noctis:server-kind', null, (value) => value === null || value === 'noctis' || value === 'opensubsonic')
/** For OpenSubsonic servers, which have no handshake: the server's name (its "type"). */
export const otherServerName = ref('')

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
  // Starting counts: a plugin's first requests happen while its code runs.
  return installedPlugins.value
    .filter((plugin) => runStates[plugin.sha256] === 'running' || runStates[plugin.sha256] === 'starting')
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
  const auth = credentials.value
  try {
    response = await httpRequest(`${serverUrl.value}${path}`, {
      method: init.method,
      body: init.body,
      headers: {
        [PLUGINS_HEADER]: encodePluginsHeader(clientPlugins()),
        [PLATFORM_HEADER]: platform,
        accept: 'application/json',
        // Legacy token credentials are for /rest only; Noctis endpoints take sessions.
        ...(auth && 'apiKey' in auth ? { authorization: `Bearer ${auth.apiKey}` } : {}),
      },
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

/** Whether `base` speaks OpenSubsonic; resolves to its "type" (e.g. "navidrome"). */
async function probeOpenSubsonic(base: string): Promise<string | null> {
  try {
    const response = await httpRequest(`${base}/rest/ping.view?f=json&v=1.16.1&c=noctis`)
    const body = (response.data as { 'subsonic-response'?: { type?: string } } | null)?.['subsonic-response']
    return body ? (body.type ?? 'OpenSubsonic') : null
  } catch {
    return null
  }
}

/**
 * Check in with the server (and remember it). Resolves to the handshake for Noctis
 * servers, or null for other OpenSubsonic servers.
 */
export async function connect(url = serverUrl.value): Promise<HandshakeResponse | null> {
  serverStatus.value = 'connecting'
  serverError.value = ''
  try {
    const base = normalize(url)
    if (base !== serverUrl.value) {
      guestAccess.value = false
      signOutLocally()
    }
    serverUrl.value = base

    let response: HandshakeResponse | null = null
    let unreachable: unknown = null
    try {
      response = await serverRequest<HandshakeResponse>('/noctis/v1/handshake')
      if (typeof response?.protocol !== 'number' || !response.result) response = null
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
      // Status 0: no answer at all. In a browser that's also what a server without Noctis's
      // CORS headers looks like (Navidrome refuses the preflight for x-noctis-*), so try
      // OpenSubsonic, which needs no custom headers, before giving up.
      if (error.status === 0) unreachable = error
    }

    if (response) {
      serverKind.value = 'noctis'
      // An open route, so it answers even before the required plugins are installed.
      const info = await serverRequest<{ guestAccess?: boolean }>('/noctis/v1/info').catch(() => null)
      if (info) guestAccess.value = info.guestAccess === true
      handshake.value = response
      serverStatus.value = response.result.ok ? 'connected' : 'needs-plugins'
      writeLog('noctis', 'info', `Connected to ${response.server.name} ${response.server.version} at ${base}${response.result.ok ? '' : ` (needs ${missingPlugins.value.map((item) => item.id).join(', ')})`}`)
    } else {
      const type = await probeOpenSubsonic(base)
      if (!type) throw unreachable ?? new ServerError("That isn't a Noctis or OpenSubsonic server", 0)
      serverKind.value = 'opensubsonic'
      guestAccess.value = false
      otherServerName.value = type
      handshake.value = null
      serverStatus.value = 'connected'
      writeLog('noctis', 'info', `Connected to an OpenSubsonic server (${type}) at ${base}`)
    }
    if (canUseServer()) attachServerService()
    else detachServerService()
    return response
  } catch (error) {
    serverStatus.value = 'error'
    serverError.value = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/**
 * Sign in to a Noctis server: the password is exchanged for a session token (which is
 * also the OpenSubsonic API key) and not kept.
 */
export async function signIn(username: string, password: string): Promise<void> {
  if (serverKind.value !== 'noctis') throw new ServerError('This server needs an API key (OpenSubsonic apiKeyAuthentication)', 0)
  const body = await serverRequest<{ token?: string; error?: string }>('/noctis/v1/auth/login', {
    method: 'POST',
    body: { username, password, label: `Noctis on ${navigator.userAgent.includes('Android') ? 'Android' : 'the web'}` },
  })
  if (!body.token) throw new ServerError(body.error ?? 'Sign-in failed', 401)
  credentials.value = { username, apiKey: body.token }
  attachServerService()
  writeLog('noctis', 'info', `Signed in to ${serverUrl.value} as ${username}`)
}

/** Sign in to another OpenSubsonic server with an API key it issued (Noctis never sends passwords to it). */
export async function signInWithApiKey(apiKey: string): Promise<void> {
  if (!(await hasExtension('apiKeyAuthentication'))) {
    throw new ServerError("This server doesn't support API keys: sign in with your username and password instead", 0)
  }
  const auth = { username: '', apiKey: apiKey.trim() }
  await subsonic('ping', {}, auth)
  const user = (await subsonic('getUser', {}, auth).catch(() => null))?.user?.username ?? 'API key'
  credentials.value = { ...auth, username: user }
  attachServerService()
  writeLog('noctis', 'info', `Signed in to ${serverUrl.value} as ${user} (API key)`)
}

/**
 * Sign in to an OpenSubsonic or Subsonic server with a username and password, for
 * servers without API keys (Navidrome's demo…): Subsonic token auth, with the password
 * turned into md5(password + salt) right away and never stored.
 */
export async function signInWithPassword(username: string, password: string): Promise<void> {
  if (serverKind.value === 'noctis') return signIn(username, password)
  const auth = tokenCredentials(username, password)
  try {
    await subsonic('ping', {}, auth)
  } catch (error) {
    // 40: wrong username or password; 41: the server wants plain passwords (not supported).
    const code = (error as { code?: number }).code
    if (code === 41) throw new ServerError("This server doesn't accept token logins, and Noctis doesn't send plain passwords", 41)
    throw new ServerError(code === 40 ? 'Wrong username or password' : error instanceof Error ? error.message : String(error), code ?? 0)
  }
  credentials.value = auth
  attachServerService()
  writeLog('noctis', 'info', `Signed in to ${serverUrl.value} as ${username} (username and password, token auth)`)
}

function signOutLocally() {
  credentials.value = null
  // A guest server stays usable without the account.
  if (guestAccess.value && serverUrl.value) attachServerService()
  else detachServerService()
}

export async function signOut() {
  if (serverKind.value === 'noctis' && credentials.value) {
    await serverRequest('/noctis/v1/auth/logout', { method: 'POST' }).catch(() => {})
  }
  signOutLocally()
}

export function disconnect() {
  void signOut()
  guestAccess.value = false
  detachServerService()
  serverUrl.value = ''
  serverKind.value = null
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
