import { extname, join, resolve, sep } from 'node:path'

/**
 * The browser client (apps/client's Vite build), served at "/" next to the APIs, like
 * Navidrome or Jellyfin serve their web UI. Admins turn it off with
 * NOCTIS_WEB_CLIENT=false, or point NOCTIS_WEB_CLIENT_DIR at another build.
 *
 * index.html gets `<meta name="noctis-server" content="same-origin">`, so a client opened
 * from a server connects to that server without asking.
 */

/**
 * Paths that belong to the server, never to the web client. The old Noctis prefix
 * (/noctis/v1, before /api/noctis/v1) stays reserved so an out-of-date client gets a 404,
 * not the app's HTML with a 200 that looks like a different kind of server.
 */
const API = /^\/(rest|api|noctis\/v1)(\/|$)/

const MARKER = '<meta name="noctis-server" content="same-origin">'

export function webClient(dir: string) {
  const root = resolve(dir)
  let index: { modified: number; html: Promise<string | null> } | null = null

  // Read again when the build changes: a rebuild replaces the fingerprinted assets the
  // old index.html points to, so a stale copy would serve a blank page.
  const indexHtml = () => {
    const file = Bun.file(join(root, 'index.html'))
    const modified = file.lastModified
    if (!index || index.modified !== modified) {
      index = { modified, html: file.text().then((html) => html.replace('<head>', `<head>\n    ${MARKER}`)).catch(() => null) }
    }
    return index.html
  }

  /** A response for `request`, or null if it isn't the web client's to answer. */
  return async function serve(request: Request): Promise<Response | null> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null
    const path = decodeURIComponent(new URL(request.url).pathname)
    if (API.test(path)) return null

    // A file from the build (never outside it)…
    const file = resolve(root, `.${path}`)
    if (path !== '/' && (file === root || file.startsWith(root + sep))) {
      const handle = Bun.file(file)
      if (await handle.exists()) {
        // Vite fingerprints assets/: they never change under the same name.
        const immutable = path.startsWith('/assets/')
        return new Response(handle, { headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } })
      }
      // A missing asset is a 404, not the app.
      if (extname(path)) return null
    }

    // …or the app itself, for "/" and any other page.
    const html = await indexHtml()
    if (html === null) return null
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
  }
}
