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
 * Load `url` in a WebView and resolve with `{ url, body }` of the first response the
 * page's own code fetches whose URL contains `match` — letting a site do its session
 * handshake (the Spotify plugin reads the web player's access token this way). Apps only.
 *
 * - Android and iOS: a hidden WebView that shares cookies with openAuthWindow's.
 * - Desktop: a visible incognito window (its cookies are its own), hooking the page's
 *   fetch/XHR. `fallbackUrl` is loaded directly, its page text taken as the response, if the
 *   page's own request wasn't seen in time. `userAgent` is mobile only: the desktop
 *   webview's own is already a real browser's.
 * - `login` signs in first: the site's sign-in page is shown until the cookie is set, then
 *   `url` is loaded signed in. Desktop does it in the same window and returns `cookies`, the
 *   site's Cookie header, to renew the session with later; mobile runs openAuthWindow (done
 *   when the page heads for cookieUrl's site) before the capture.
 */
export async function captureWebResponse(options: {
  url: string
  match: string
  userAgent?: string
  timeoutMs?: number
  title?: string
  fallbackUrl?: string
  login?: { url: string; cookieUrl: string; cookie: string }
}): Promise<{ url: string; body: string; cookies?: string }> {
  const { login, match, ...rest } = options
  if (isDesktop) {
    return invoke('capture_web_response', { ...rest, pattern: match, loginUrl: login?.url, loginCookieUrl: login?.cookieUrl, loginCookie: login?.cookie })
  }
  if (!hasNoctisPlugin) throw new Error('Only available in the apps')
  // The sign-in window closes the moment it heads for the site (the hidden WebView shares its
  // cookies); openCookieLogin would keep the whole site loading in it.
  if (login) await openAuthWindow({ url: login.url, redirect: new URL(login.cookieUrl).origin, title: options.title })
  return Noctis.captureResponse({ url: options.url, match, userAgent: options.userAgent, timeoutMs: options.timeoutMs })
}

/** Sign a site out: remove the cookies sent to `url` (other sites keep theirs). */
export async function clearSiteCookies(url: string) {
  if (hasNoctisPlugin) await Noctis.clearCookies({ url })
}

/** Whether openCookieLogin and captureWebResponse work here (the apps, not the browser). */
export const canCaptureWeb = hasNoctisPlugin || isDesktop
