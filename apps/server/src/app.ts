import { decodePluginsHeader, PLATFORM_HEADER, PLUGINS_HEADER } from '@noctis/plugin-core'
import { Elysia } from 'elysia'
import { handshakeFor, noctisRoutes, SERVER_VERSION } from './noctis/routes'
import type { Services } from './services'
import { createSubsonic } from './subsonic/router'

export { SERVER_VERSION }

/**
 * The server's HTTP surface:
 *
 *   /rest/*           OpenSubsonic, for any Subsonic/OpenSubsonic client
 *   /noctis/v1/*      Noctis: plugin negotiation, accounts, sources, recommendations
 *   /api/plugins/:id  each plugin's own routes
 *
 * Noctis clients send `x-noctis-plugins: id@version,…` (and `x-noctis-platform`) with every request. With
 * enforceClientPlugins on, /noctis and /api requests from a client that lacks a
 * required plugin get 428 Precondition Required and the handshake, saying what to
 * install. /rest is never checked: OpenSubsonic clients can't negotiate plugins.
 */

/** Routes a client can call before it has the required plugins. */
const OPEN_ROUTES = [/^\/noctis\/v1\/(info|handshake|plugins|auth\/[a-z]+)$/, /^\/noctis\/v1\/plugins\/[^/]+\/client\.noctis$/]

export function createApp(services: Services) {
  const { config, plugins } = services
  const subsonic = createSubsonic(services, SERVER_VERSION)
  const clientPluginsOf = (request: Request) => decodePluginsHeader(request.headers.get(PLUGINS_HEADER))
  const platformOf = (request: Request) => request.headers.get(PLATFORM_HEADER)

  return new Elysia()
    .onBeforeHandle(async ({ request }) => {
      const path = new URL(request.url).pathname
      const clientPlugins = clientPluginsOf(request)

      const hooked = await plugins.hooks.runBefore<Response>('onRequest', { request, path, clientPlugins })
      if (hooked.stopped) return hooked.response

      const negotiated = path.startsWith('/noctis/') || path.startsWith('/api/')
      if (config.enforceClientPlugins && negotiated && !OPEN_ROUTES.some((route) => route.test(path))) {
        const body = await handshakeFor(services, clientPlugins, platformOf(request))
        if (!body.result.ok) return Response.json(body, { status: 428 })
      }
    })

    .all('/rest/:endpoint', ({ request, params }) => subsonic(request, params.endpoint))

    .use(noctisRoutes(services))

    .all('/api/plugins/:id/*', async ({ params, request, status }) => {
      const plugin = plugins.plugins.get(params.id)
      const router = plugin?.state === 'running' ? plugin.api?.router : null
      if (!plugin || !router) return status(404, { error: `No plugin "${params.id}" with routes on this server` })

      // The plugin's own routes need its client half, even with enforcement off.
      if (plugin.archive.manifest.side === 'both' && plugin.archive.manifest.client?.required) {
        const body = await handshakeFor(services, clientPluginsOf(request), platformOf(request))
        const missing = [...body.result.missing, ...body.result.outdated.map((item) => item.requirement)]
        if (missing.some((item) => item.id === params.id)) return Response.json(body, { status: 428 })
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
  'access-control-allow-headers': `content-type, authorization, range, ${PLUGINS_HEADER}, ${PLATFORM_HEADER}`,
  'access-control-expose-headers': 'content-length, content-range, accept-ranges',
  'access-control-max-age': '86400',
}

/**
 * A fetch handler around the app with CORS for browser clients. The API uses no
 * cookies (credentials are API keys), so any origin may call it.
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
