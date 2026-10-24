import {
  checkClientPlugins,
  decodePluginsHeader,
  PLUGINS_HEADER,
  PROTOCOL_VERSION,
  type ClientPlugin,
  type HandshakeResponse,
} from '@noctis/plugin-core'
import { Elysia } from 'elysia'
import type { ServerConfig } from './config'
import type { PluginManager } from './plugins/manager'

export const SERVER_VERSION = '0.1.0'

/**
 * The HTTP API.
 *
 *   GET  /api/v1/info                          server name and versions
 *   GET  /api/v1/handshake                     what this client is missing (send x-noctis-plugins)
 *   GET  /api/v1/plugins                       the server's plugins
 *   GET  /api/v1/plugins/:id/client.noctis     a "both" plugin's client half, to install
 *   ANY  /api/plugins/:id/*                    a plugin's own routes
 *
 * Clients send `x-noctis-plugins: id@version,…` with every request. With
 * enforceClientPlugins on, any other API request from a client that lacks a required
 * plugin gets 428 Precondition Required and the handshake body, saying what to install.
 * A plugin's own routes always require that plugin's client half (when it's required).
 */

/** Routes a client can call before it has the required plugins. */
const OPEN_ROUTES = [/^\/api\/v1\/(info|handshake)$/, /^\/api\/v1\/plugins(\/[^/]+\/client\.noctis)?$/]

export function createApp(config: ServerConfig, plugins: PluginManager) {
  const handshake = async (client: ClientPlugin[]): Promise<HandshakeResponse> => {
    const requirements = plugins.clientRequirements()
    const response: HandshakeResponse = {
      protocol: PROTOCOL_VERSION,
      server: { name: config.name, version: SERVER_VERSION },
      plugins: requirements,
      result: checkClientPlugins(requirements, client),
    }
    const after = await plugins.hooks.run<HandshakeResponse>('onHandshake', 'after', { response })
    return after.stopped ? after.response : response
  }

  const preconditionFailed = (body: HandshakeResponse) => Response.json(body, { status: 428 })

  return new Elysia()
    .onBeforeHandle(async ({ request }) => {
      const path = new URL(request.url).pathname
      const clientPlugins = decodePluginsHeader(request.headers.get(PLUGINS_HEADER))

      const hooked = await plugins.hooks.runBefore<Response>('onRequest', { request, path, clientPlugins })
      if (hooked.stopped) return hooked.response

      if (config.enforceClientPlugins && path.startsWith('/api/') && !OPEN_ROUTES.some((route) => route.test(path))) {
        const body = await handshake(clientPlugins)
        if (!body.result.ok) return preconditionFailed(body)
      }
    })

    .get('/api/v1/info', () => ({
      name: config.name,
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
    }))

    .get('/api/v1/handshake', ({ request }) => handshake(decodePluginsHeader(request.headers.get(PLUGINS_HEADER))))

    .get('/api/v1/plugins', () =>
      [...plugins.plugins.entries()].map(([id, { archive, state }]) => ({
        id,
        name: archive.manifest.name,
        version: archive.manifest.version,
        side: archive.manifest.side,
        description: archive.manifest.description,
        authors: archive.manifest.authors,
        source: archive.manifest.source,
        state,
        client: archive.manifest.client,
      })),
    )

    .get('/api/v1/plugins/:id/client.noctis', ({ params, status }) => {
      const bytes = plugins.clientArchive(params.id)
      if (!bytes) return status(404, { error: `No client plugin "${params.id}" on this server` })
      return new Response(bytes, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${params.id}.noctis"`,
        },
      })
    })

    .all('/api/plugins/:id/*', async ({ params, request, status }) => {
      const plugin = plugins.plugins.get(params.id)
      const router = plugin?.state === 'running' ? plugin.api?.router : null
      if (!plugin || !router) return status(404, { error: `No plugin "${params.id}" with routes on this server` })

      // The plugin's own routes need its client half, even with enforcement off.
      const requirement = plugin.archive.manifest.client
      if (plugin.archive.manifest.side === 'both' && requirement?.required) {
        const body = await handshake(decodePluginsHeader(request.headers.get(PLUGINS_HEADER)))
        const mine = body.result.missing.concat(body.result.outdated.map((item) => item.requirement)).some((item) => item.id === params.id)
        if (mine) return preconditionFailed(body)
      }

      // Hand the request to the plugin's router, with the prefix stripped.
      const url = new URL(request.url)
      url.pathname = `/${params['*'] ?? ''}`
      return router.handle(new Request(url.href, request))
    })
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': `content-type, authorization, ${PLUGINS_HEADER}`,
  'access-control-max-age': '86400',
}

/**
 * A fetch handler around the app with CORS for browser clients. The API uses no
 * cookies, so any origin may call it; credentials are bearer tokens (later).
 */
export function withCors(handle: (request: Request) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    const response = await handle(request)
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
