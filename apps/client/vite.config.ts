import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * In the browser, InnerTube requests are blocked by CORS and forbidden headers
 * (Cookie, Origin, User-Agent). The app rewrites them to `/__yt/<host>/<path>` in
 * development, and this middleware forwards them with the right headers. On a device
 * the same requests go through Capacitor's native HTTP stack instead.
 */
const PROXY_PREFIX = '/__yt/'
const ALLOWED_HOSTS = /^(music\.youtube\.com|www\.youtube\.com|youtubei\.googleapis\.com|jnn-pa\.googleapis\.com|[a-z0-9-]+\.googlevideo\.com|api-partner\.spotify\.com|clienttoken\.spotify\.com|open\.spotify\.com|open\.spotifycdn\.com)$/
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function innertubeProxy(): Plugin {
  return {
    name: 'noctis-innertube-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(PROXY_PREFIX)) return next()

        const rest = req.url.slice(PROXY_PREFIX.length)
        const slash = rest.indexOf('/')
        const host = slash === -1 ? rest : rest.slice(0, slash)
        if (!ALLOWED_HOSTS.test(host)) {
          res.statusCode = 403
          res.end('host not allowed')
          return
        }

        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value !== 'string') continue
          const lower = name.toLowerCase()
          if (['host', 'connection', 'origin', 'referer', 'cookie', 'accept-encoding'].includes(lower)) continue
          if (lower.startsWith('sec-') || lower === 'user-agent') continue
          if (lower.startsWith('x-noctis-')) {
            headers.set(lower.slice('x-noctis-'.length), value)
            continue
          }
          headers.set(name, value)
        }
        if (!headers.has('user-agent')) headers.set('user-agent', DESKTOP_UA)
        if (host.endsWith('youtube.com')) {
          headers.set('origin', `https://${host}`)
          headers.set('referer', `https://${host}/`)
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)

        try {
          const upstream = await fetch(`https://${rest}`, {
            method: req.method,
            headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            redirect: 'follow',
          })
          res.statusCode = upstream.status
          upstream.headers.forEach((value, name) => {
            if (['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(name)) return
            res.setHeader(name, value)
          })
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (error) {
          res.statusCode = 502
          res.end(String(error))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), innertubeProxy()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
})
