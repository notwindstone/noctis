import { invoke } from '@tauri-apps/api/core'
import { hasNoctisPlugin, isDesktop, Noctis } from './native'

/**
 * OAuth for plugins: open an authorization page and resolve with the URL it redirects
 * to (the one starting with `redirect`), e.g. to read `?code=` in a PKCE flow.
 *
 * - On a device or desktop, a window catches the redirect before loading it, so any
 *   redirect URI works — it never has to resolve.
 * - In the browser (development), a popup ends on /auth-callback.html, which passes its
 *   URL back over a BroadcastChannel. The redirect must then be this origin's
 *   `/auth-callback.html` (see AUTH_CALLBACK).
 */
export async function openAuthWindow(options: { url: string; redirect: string; title?: string }): Promise<string> {
  if (hasNoctisPlugin) return (await Noctis.openAuth(options)).url
  if (isDesktop) return invoke<string>('open_auth', options)

  return new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel('noctis-auth')
    const popup = window.open(options.url, 'noctis-auth', 'width=480,height=720')
    if (!popup) {
      channel.close()
      reject(new Error('The sign-in window was blocked'))
      return
    }
    const timeout = window.setTimeout(() => {
      channel.close()
      reject(new Error('Sign-in timed out'))
    }, 10 * 60_000)
    channel.onmessage = (event: MessageEvent<{ url?: string }>) => {
      const url = event.data?.url
      if (!url || !url.startsWith(options.redirect)) return
      window.clearTimeout(timeout)
      channel.close()
      resolve(url)
    }
  })
}

/**
 * A site's own sign-in page, for sites whose session is a cookie (SoundCloud's
 * oauth_token): resolves once the site sets it, with its value and every cookie on
 * `cookieUrl` as a Cookie header, httpOnly ones included (where refresh tokens live).
 * Device and desktop only; in the browser, let people paste the values instead.
 */
export async function openCookieLogin(options: { url: string; cookieUrl: string; cookie: string; title?: string }): Promise<{ value: string; cookies: string }> {
  if (isDesktop) return invoke('open_cookie_login', options)
  if (!hasNoctisPlugin) throw new Error('Only available in the apps, not the browser')
  const result = await Noctis.openCookieLogin(options)
  return { value: result.value, cookies: result.cookies ?? '' }
}

/** The redirect URI that works in the browser: this origin's callback page. */
export const AUTH_CALLBACK = `${location.origin}/auth-callback.html`

/**
 * Load `url` in a hidden WebView and resolve with the body of the first response whose
 * URL contains `match` — letting a site's own code do its session handshake (the
 * Spotify plugin reads the web player's access token this way). The WebView shares the
 * app's cookies, so a session signed in with openAuthWindow carries over. Device only.
 */
export async function captureWebResponse(options: { url: string; match: string; userAgent?: string; timeoutMs?: number }) {
  if (!hasNoctisPlugin) throw new Error('Only available in the Android app')
  return Noctis.captureResponse(options)
}

/** Sign a site out: remove the cookies sent to `url` (other sites keep theirs). */
export async function clearSiteCookies(url: string) {
  if (hasNoctisPlugin) await Noctis.clearCookies({ url })
}

/** Whether openCookieLogin works here (captureWebResponse is Android only). */
export const canCaptureWeb = hasNoctisPlugin || isDesktop
