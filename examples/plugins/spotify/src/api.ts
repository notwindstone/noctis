import { Noctis, type Song } from './host'

/**
 * The session and the GraphQL API, both borrowed from Spotify's web player.
 *
 * - The session: an open.spotify.com page (Noctis.libs.auth.captureWebResponse: hidden
 *   on Android, a window on desktop) runs Spotify's own code, TOTP included, and we read
 *   its access token response. Signing in is a normal Spotify login page, followed in
 *   the same window by the player. Desktop renewals replay the token request from here
 *   with the window's cookies (a TOTP built the way the web player builds it, see
 *   mintToken). Without signing in you still get an anonymous session: home, search,
 *   albums, artists and playlists.
 * - The client token: the web player's transport token (clienttoken.spotify.com),
 *   attached to the same requests Spotify's own player attaches it to.
 * - The data: the web player's GraphQL API (api-partner.spotify.com/pathfinder). Its
 *   operations are identified by hashes, read from the web player's own scripts, so a
 *   Spotify update doesn't need a plugin update.
 */

const { ref, computed } = Noctis.packages.vue
const { http } = Noctis.libs

export const SOURCE = 'spotify'
export const WEB_PLAYER = 'https://open.spotify.com/'
export const GRAPHQL = 'https://api-partner.spotify.com/pathfinder/v2/query'
export const WEBGATE = 'https://spclient.wg.spotify.com'
/** The web player's own public client id (clienttoken.spotify.com). */
export const WEB_CLIENT_ID = 'd8a5ed958d274c2e8ee717e6a4b0971d'
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

/** Hashes seen in October 2026, used until (or if) discovery from the web player fails. */
export const KNOWN_OPERATIONS: Record<string, string> = {
  home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
  searchDesktop: 'eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03',
  searchTracks: 'b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751',
  searchAlbums: '202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9',
  searchArtists: '7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d',
  searchPlaylists: 'd520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1',
  searchSuggestions: 'f244254b94c0e824d458ac216e0f8406a73f2f69a9ff52831a2f78fa774ff6ce',
  getAlbum: '0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f',
  queryArtistOverview: '9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6',
  fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
  fetchPlaylistContents: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
  addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
}

/* ------------------------------------------------------------------ *
 * State (kept with Plugin.storage)
 * ------------------------------------------------------------------ */

export type Raw = Record<string, any>
/** { token, expiresAt, anonymous } — the web player's access token. */
export interface SpotifySession {
  token: string
  expiresAt: number
  anonymous: boolean
  /**
   * The open.spotify.com Cookie header that minted the token (desktop and
   * pasted-cookie sessions). Tokens expire hourly; these last much longer and
   * silently re-mint. Kept when the host has no token-capture of its own.
   */
  cookies?: string
  /** Set for a manually pasted token: there is nothing to re-mint with. */
  pasted?: boolean
}
export interface Me {
  id: string
  name: string
  photo?: string
}

export interface PluginStorage {
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  remove(key: string): void
}/** { token, expiresAt, anonymous, cookies? } — the web player's access token. */
export const session = ref<SpotifySession | null>(null)
/** { id, name, photo } once signed in; null for the anonymous session. */
export const me = ref<Me | null>(null)
/** Random id the home feed asks for (the web player keeps one per browser). */
export const deviceId = ref('')
/** The web player's operations (hashes + app version), read from its scripts. */
export interface Operations {
  hashes: Record<string, string>
  appVersion?: string
  /** The token TOTP's secrets, newest first (also read from its scripts). */
  totps?: TotpEntry[]
  at: number
}
export const operations = ref<Operations | null>(null)

export const signedIn = computed(() => me.value !== null)

export function initSession(storage: PluginStorage) {
  session.value = storage.get<SpotifySession>('session') ?? null
  me.value = storage.get<Me>('me') ?? null
  operations.value = storage.get<Operations>('operations') ?? null
  deviceId.value = storage.get<string>('device') ?? ''
  if (!deviceId.value) {
    deviceId.value = crypto.randomUUID()
    storage.set('device', deviceId.value)
  }
  storageRef = storage
}

let storageRef: PluginStorage | undefined

/** Plugin log lines (the plugin id is the source; see Settings → Log). */
function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]) {
  Noctis.writeLog(SOURCE, level, ...parts)
}

function persist() {
  if (!storageRef) return
  if (session.value) storageRef.set('session', session.value)
  else storageRef.remove('session')
  if (me.value) storageRef.set('me', me.value)
  else storageRef.remove('me')
  if (operations.value) storageRef.set('operations', operations.value)
}

export function setSession(value: SpotifySession | null) {
  session.value = value
  persist()
}

export function setMe(value: Me | null) {
  me.value = value
  persist()
}

export function setOperations(value: Operations) {
  operations.value = value
  persist()
}

/** A URL without its query and fragment (they can carry one-time codes). */
export const redactUrl = (url: string) => String(url ?? '').replace(/[?#].*$/, (rest) => (rest.length > 1 ? '?…' : ''))

export const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** The profile inside the GraphQL answer's avatar sources. */
export function largest(sources: Raw | Raw[] | undefined | null): string | undefined {
  const list = sources as Raw[] | undefined
  if (!list?.length) return undefined
  return [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url
}

/* ------------------------------------------------------------------ *
 * Session: the web player's token, captured from a hidden open.spotify.com
 * ------------------------------------------------------------------ */

let capturing: Promise<SpotifySession> | null = null

const { isDesktop, hasNoctisPlugin } = Noctis.libs.native

/** What a fresh session costs on this host (interactive sign-in only). */
export function signInHint(): string {
  if (isDesktop || hasNoctisPlugin) return 'Sign in to Spotify again (Settings → Accounts → Spotify)'
  return "This Spotify plugin signs in through Noctis's Android or desktop app — paste-from-browser won't work here without one."
}

/** Apply a minted or captured session; go anonymous when the sign-in lapsed. */
function adopt(next: SpotifySession): SpotifySession {
  setSession(next)
  if (next.anonymous && me.value) {
    setMe(null)
    log('warn', 'Spotify is anonymous now; personal content needs a sign-in')
  }
  return next
}

/** The app path, one for every app: an open.spotify.com page (hidden on Android, a window
 * on desktop) runs Spotify's own code, TOTP included, and we read its token response.
 * `signIn` shows Spotify's login first (the host does it: see captureWebResponse). */
export async function captureSession({ signIn = false } = {}): Promise<SpotifySession> {
  const auth = Noctis.libs.auth
  if (!auth.canCaptureWeb) throw new Error(signInHint())
  const loginUrl = `https://accounts.spotify.com/login?continue=${encodeURIComponent(WEB_PLAYER)}`
  // sp_dc is the signed-in web player's cookie; it survives about a year.
  const login = signIn ? { url: loginUrl, cookieUrl: WEB_PLAYER, cookie: 'sp_dc' } : undefined
  const desktop = isDesktop ? { title: signIn ? 'Sign in to Spotify' : 'Talking to Spotify…', fallbackUrl: await tokenPageUrl() } : {}
  log('info', '[auth] Capturing a session from the hidden web player…')
  const started = Date.now()
  let captured
  try {
    captured = await auth.captureWebResponse({ url: WEB_PLAYER, match: '/api/token', userAgent: DESKTOP_UA, timeoutMs: 40_000, login, ...desktop })
  } catch (error) {
    log('error', `[auth] Capture failed after ${Date.now() - started} ms: ${(error as Error).message}`)
    throw error
  }
  const json = parseTokenBody(captured.body, captured.url, started)
  const session = adopt({
    token: String(json.accessToken),
    expiresAt: (Number(json.accessTokenExpirationTimestampMs) || Date.now() + 3_600_000) - 120_000,
    anonymous: Boolean(json.isAnonymous),
    cookies: captured.cookies,
  })
  if (signIn && session.anonymous) throw new Error("Spotify didn't keep the sign-in; try again")
  return session
}

/** Desktop safety net for captureSession: the token request itself, to be loaded as a page
 * (should the web player ever make it where its fetch can't be watched). */
async function tokenPageUrl(): Promise<string> {
  await ensureOperations().catch(() => {})
  const entry = (operations.value?.totps?.length ? operations.value.totps : BUNDLED_TOTPS)[0]
  let at = Date.now()
  try {
    const serverTime = Number(((await http.request('https://open.spotify.com/api/server-time', { headers: { 'user-agent': DESKTOP_UA } })).data as Raw)?.serverTime)
    if (serverTime) at = serverTime * 1000
  } catch {}
  const totp = await totpCode(entry, at)
  return `https://open.spotify.com/api/token?${new URLSearchParams({ reason: 'init', productType: 'web-player', totp, totpServer: totp, totpVer: String(entry.version) })}`
}

/* ------------------------------------------------------------------ *
 * The token request, replayed from here
 *
 * The web player's /api/token has grown an OTP check (the URL gets totp,
 * totpServer and totpVer; the codes are RFC-6238-style six-digit codes with a
 * 30 s step and a SHA1 HMAC). The secret ships obfuscated in the web player's
 * bundle, so it's read from there during operations discovery — when that
 * fails, the October 2026 list below keeps working until the next rotation.
 * ------------------------------------------------------------------ */

export interface TotpEntry {
  /** The obfuscated secret, exactly as the bundle spells it. */
  secret: string
  version: number
}

/** Hashes seen in October 2026, used until (or if) discovery from the web player fails. */
export const BUNDLED_TOTPS: TotpEntry[] = [
  { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
  { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
  { secret: '{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH', version: 59 },
]

/** Undo the bundle's XOR-obfuscation: each char code XORed with its index mod 33 + 9. */
function deobfuscate(secret: string): string {
  return [...secret].map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ (i % 33) + 9)).join('')
}

const textEncoder = new TextEncoder()

/** The six-digit code the web player would generate at time `at` (ms). */
async function totpCode(entry: TotpEntry, at: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(deobfuscate(entry.secret)), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const counter = new DataView(new ArrayBuffer(8))
  // The bundle's generator packs the counter into the last four bytes of eight.
  counter.setUint32(4, Math.floor(at / 1000 / 30))
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer))
  const half = mac[19] & 15
  const code = (((mac[half] & 127) << 24) | (mac[half + 1] << 16) | (mac[half + 2] << 8) | mac[half + 3]) % 1_000_000
  return String(code).padStart(6, '0')
}

/** Mint a session by replaying the web player's token request. An empty cookie
 * string mints an anonymous one (the endpoint hands those out on demand); a real
 * open.spotify.com Cookie header upgrades it to signed-in when the jar holds the
 * SSO session. Replays a shape proven against the live endpoint in October 2026:
 * Chrome on Windows headers, and one server-time code for both TOTP params. */
export async function mintToken(cookies: string): Promise<SpotifySession> {
  const jar = String(cookies ?? '').replace(/^\s*cookie\s*:\s*/i, '').trim()
  await ensureOperations().catch(() => {})
  const entries = operations.value?.totps?.length ? operations.value.totps : BUNDLED_TOTPS
  // Only the browser's dev-server proxy drops origin/referer/cookie; there they go through
  // x-noctis-* aliases, which it maps back to their real names.
  const prefix = isDesktop || hasNoctisPlugin ? '' : 'x-noctis-'
  // The whole Chrome-shaped header block: the endpoint fingerprints "browser
  // enough" requests, and refused networks only pass with the full set (reqwest
  // may set even the sec-* headers a browser fetch cannot).
  const headers: Record<string, string> = {
    'user-agent': DESKTOP_UA,
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
  // No accept-encoding negociation: the app's HTTP layer has no gzip/brotli
  // decoders, and compressed error bodies logged as noise. identity keeps the
  // payloads readable.
    'accept-encoding': 'identity',
    dnt: '1',
    'sec-ch-ua': '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    [`${prefix}origin`]: 'https://open.spotify.com/',
    [`${prefix}referer`]: 'https://open.spotify.com/',
    ...(jar ? { [`${prefix}cookie`]: jar } : {}),
  }
  log('info', `[auth] Minting a token ${jar ? `(cookie names: ${jar.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean).join(', ')})` : 'without cookies (anonymous)'}, ` +
    `TOTP versions ${entries.map((entry) => entry.version).join('/')}`)

  // The codes are checked against Spotify's own clock, so build them from
  // /api/server-time instead of this device's (an off PC clock would 400 every
  // window silently). The web player builds its server-side code the same way.
  let at = Date.now()
  try {
    const when = await http.request('https://open.spotify.com/api/server-time', { headers })
    const serverTime = Number((when.data as Raw)?.serverTime)
    if (serverTime && !isNaN(serverTime)) {
      const skew = Math.round(((at - serverTime * 1000) / 1000))
      log('info', `[auth] Server time ok (this device's clock is ${skew >= 0 ? `${skew}s ahead` : `${-skew}s behind`})`)
      at = serverTime * 1000
    }
  } catch (error) {
    log('warn', `[auth] Server time unavailable (${(error as Error).message}); using this device's clock`)
  }

  let last = 'no answer'
  for (const [index, entry] of entries.entries()) {
    // The newest version is the one that should work: give it several well-spaced
    // tries — refused bursts (this endpoint throttles by IP) are the usual reason
    // for an unanswered one. Older versions are backups.
    const tries = index === 0 ? 4 : 1
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await sleep(4_000 * attempt)
      const totp = await totpCode(entry, at)
      const params = new URLSearchParams({ reason: 'init', productType: 'web-player', totp, totpServer: totp, totpVer: String(entry.version) })
      const response = await http.request(`https://open.spotify.com/api/token?${params}`, { headers })
      const json = response.data as Raw
      if (response.status === 200 && json?.accessToken) {
        log('info', `[auth] Minted a token (totpVer ${entry.version}, attempt ${attempt + 1}/${tries}): anonymous=${Boolean(json.isAnonymous)}, ` +
          `expires in ${Math.round((Number(json.accessTokenExpirationTimestampMs) - Date.now()) / 60_000)} min`)
        return {
          token: String(json.accessToken),
          expiresAt: (Number(json.accessTokenExpirationTimestampMs) || Date.now() + 3_600_000) - 120_000,
          anonymous: Boolean(json.isAnonymous),
          cookies: jar || undefined,
        }
      }
      last = `HTTP ${response.status} (totpVer ${entry.version}, try ${attempt + 1}): ${typeof json === 'string' ? json : JSON.stringify(json ?? response.data ?? '').slice(0, 200)}`
      log('warn', `[auth] Token attempt failed — ${last}`)
      // The endpoint tells us a version's policy lifetime ran out; older versions
      // can only be expired too, so don't grind through them.
      if (json && typeof json === 'object' && 'totpVerExpired' in json) {
        const until = (json as Raw).totpValidUntil ? ` (valid until ${(json as Raw).totpValidUntil})` : ''
        throw new Error(`Spotify rejected TOTP version ${entry.version} as expired ${until}; Spotify updated its token flow and a newer secret didn't arrive — check or reinstall the plugin`)
      }
    }
  }
  throw new Error(`Spotify didn't hand out a token: ${last}. A try in a few minutes often works — this endpoint throttles whole networks briefly.`)
}

/** Shared body parser of the captured/minted token response (logs the shape, never the token). */
function parseTokenBody(body: string, url: string, started: number): Raw {
  let json: Raw
  try {
    json = JSON.parse(body)
  } catch {
    throw new Error("Spotify didn't hand out a session")
  }
  log(
    'info',
    `[auth] Got ${redactUrl(url)} in ${Date.now() - started} ms: ` +
      `anonymous=${json.isAnonymous}, token=${json.accessToken ? `${String(json.accessToken).length} chars` : 'missing'}, ` +
      `expires in ${json.accessTokenExpirationTimestampMs ? Math.round((Number(json.accessTokenExpirationTimestampMs) - Date.now()) / 60_000) : '?'} min`,
  )
  if (!json.accessToken) throw new Error("Spotify didn't hand out a session")
  return json
}

/* ------------------------------------------------------------------ *
 * The sign-in flows (one per host)
 * ------------------------------------------------------------------ */

/** Paste fallback (any host): the Cookie header of any open.spotify.com request. */
export async function signInWithCookies(pasted: string): Promise<SpotifySession> {
  const jar = String(pasted ?? '').replace(/^\s*Cookie\s*:\s*/i, '').trim()
  if (!/(^|;\s*)sp_[a-z_]+=/.test(jar)) {
    throw new Error("That doesn't look like Spotify cookies: open open.spotify.com, then DevTools → Network → any request → Request Headers → copy the whole Cookie line (it needs sp_dc or sp_t)")
  }
  return adopt(await mintToken(jar))
}

/** Last-resort for networks Spotify refuses to mint from (shared proxies): an
 * access token copied out of a working browser's /api/token response. Accepts
 * the bare token, token followed by its expiry (ms epoch), or the whole
 * response JSON pasted as is. */
export async function signInWithToken(pasted: string): Promise<SpotifySession> {
  const raw = String(pasted ?? '').trim()
  const token = raw.includes('"accessToken"') ? (raw.match(/"accessToken"\s*:\s*"([^"]+)"/)?.[1] ?? '') : raw.split(/[|\n]/)[0]?.trim() ?? ''
  const expiry = Number((raw.match(/"accessTokenExpirationTimestampMs"\s*:\s*(\d+)/) ?? [])[1] ?? raw.split(/[|\n]/)[1])
  if (!/^[A-Za-z0-9_-]{80,}$/.test(token)) {
    throw new Error("That isn't a Spotify access token: in the open.spotify.com response it's the long value of accessToken")
  }
  const next: SpotifySession = { token, expiresAt: expiry > 1e12 ? expiry - 120_000 : Date.now() + 55 * 60_000, anonymous: true, pasted: true }
  // Who the token belongs to only the API knows: probe like refreshProfile does.
  setSession(next)
  try {
    const data = await gql('profileAttributes', {})
    const profile = data?.me?.profile
    next.anonymous = !profile
    if (profile) {
      setMe({ id: String(profile.username ?? profile.uri), name: String(profile.name || profile.username), photo: largest(profile.avatar?.sources) })
      log('info', '[auth] The pasted token belongs to a signed-in account')
    }
  } catch (error) {
    log('warn', `[auth] Couldn't check the pasted token's account (${(error as Error).message}); treating it as anonymous`)
  }
  setSession({ ...next })
  return next
}

export async function accessToken({ fresh = false } = {}): Promise<string> {
  const current = session.value
  if (!fresh && current?.token && current.expiresAt > Date.now()) return current.token
  const lapsed = current && (fresh || current.expiresAt <= Date.now() || !current.token)
  // A pasted token can't be renewed: the app's own session would silently replace the account.
  if (current?.pasted && lapsed) {
    throw new Error('The pasted Spotify token has expired — sign in again and paste a fresh one from the browser (they last about an hour)')
  }
  // Desktop and cookie sessions: replay the token request with the stored cookies (they far
  // outlive the hourly token); without any, the same request returns a plain anonymous
  // token. Failing silently is fine: quietly opening a sign-in window from a background
  // request would be rude.
  if (current && lapsed && (isDesktop || current.cookies)) {
    try {
      const renewed = await mintToken(current.cookies ?? '')
      setSession(renewed)
      return renewed.token
    } catch (error) {
      log('warn', `[auth] Re-minting the token failed: ${(error as Error).message}`)
      throw new Error(signInHint())
    }
  }
  capturing ??= captureSession().finally(() => {
    capturing = null
  })
  return (await capturing).token
}

/* ------------------------------------------------------------------ *
 * Client token: the web player's transport token
 * ------------------------------------------------------------------ */

interface ClientToken {
  token: string
  refreshAt: number
}

let clientTokenValue: ClientToken | null = null
let askingClientToken: Promise<ClientToken | null> | null = null

/** The web player's client token, or null when Spotify doesn't hand one out (it's optional). */
export async function clientToken({ fresh = false } = {}): Promise<string | null> {
  if (!fresh && clientTokenValue && clientTokenValue.refreshAt > Date.now()) return clientTokenValue.token
  askingClientToken ??= (async () => {
    try {
      const response = await http.request('https://clienttoken.spotify.com/v1/clienttoken', {
        method: 'POST',
        headers: { 'user-agent': DESKTOP_UA, accept: 'application/json', 'content-type': 'application/json;charset=UTF-8' },
        body: {
          client_data: {
            client_version: operations.value?.appVersion ?? '1.0.0',
            client_id: WEB_CLIENT_ID,
            js_sdk_data: {
              device_id: deviceId.value,
              device_type: 'computer',
              os: 0,
              os_version: '',
              platform_identifier: 'web_player',
            },
          },
        },
      })
      const granted = (response.data as Raw)?.granted_token
      if (response.status !== 200 || !granted?.token) return null
      const minutes = Number(granted.refresh_after_seconds ?? 300)
      clientTokenValue = { token: String(granted.token), refreshAt: Date.now() + minutes * 1000 - 30_000 }
      return clientTokenValue
    } catch (error) {
      log('warn', `[client-token] ${(error as Error).message}`)
      return null
    } finally {
      askingClientToken = null
    }
  })()
  return (await askingClientToken)?.token ?? null
}

/* ------------------------------------------------------------------ *
 * Operations: hashes read from the web player's scripts
 * ------------------------------------------------------------------ */

const OPERATION = /"(\w+)","(?:query|mutation)","([0-9a-f]{64})"/g
/** `{secret:'…',version:61}` — the token endpoint's OTP secrets (obfuscated). */
const TOTP_SECRET = /\{secret:(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'),version:(\d+)\}/g
/** Undo the bundle's own string-escapes (the secrets arrive as raw script text). */
const unescapeLiteral = (value: string) => value.replace(/\\(.)/g, '$1')

async function text(url: string): Promise<string> {
  const response = await http.request(url, { headers: { 'user-agent': DESKTOP_UA } })
  if (response.status !== 200 || typeof response.data !== 'string') throw new Error(`HTTP ${response.status} for ${url}`)
  return response.data
}

/** Read every operation hash from the web player bundle and its search chunk. */
async function discoverOperations(): Promise<Operations | null> {
  const html = await text(WEB_PLAYER)
  const bundle = html.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[0-9a-f]+\.js/)?.[0]
  if (!bundle) throw new Error('web player bundle not found')
  const main = await text(bundle)
  const found: Record<string, string> = {}
  for (const [, name, hash] of main.matchAll(OPERATION)) found[name] ??= hash

  // Search lives in a lazily loaded chunk: find its file name in the chunk map.
  const chunkId = main.match(/(\d+):"xpui-routes-search"/)?.[1]
  if (chunkId) {
    const base = bundle.slice(0, bundle.lastIndexOf('/') + 1)
    for (const [, hash] of main.matchAll(new RegExp(`[,{]${chunkId}:"([0-9a-f]{8})"`, 'g'))) {
      const chunk = await text(`${base}xpui-routes-search.${hash}.js`).catch(() => null)
      if (!chunk) continue
      for (const [, name, opHash] of chunk.matchAll(OPERATION)) found[name] ??= opHash
      break
    }
  }
  const appVersion = main.match(/"spotify-app-version",value:"(\d+)"/)?.[1]
  // The token TOTP's secrets ride in the same bundle, newest first.
  const totps = [...main.matchAll(TOTP_SECRET)]
    .map(([, double, single, version]) => ({ secret: unescapeLiteral(double ?? single ?? ''), version: Number(version) }))
    .sort((a, b) => b.version - a.version)
  const next = { hashes: found, appVersion, totps: totps.length ? totps : undefined, at: Date.now() }
  setOperations(next)
  log(
    'info',
    `Found ${Object.keys(found).length} Spotify operations` +
      (totps.length ? `, TOTP versions ${totps.map((entry) => entry.version).join('/')}` : ', no OTP secrets'),
  )
  return next
}

export async function ensureOperations(force = false): Promise<Operations | null> {
  const stale = !operations.value || Date.now() - operations.value.at > 24 * 3_600_000
  if (force || stale) {
    await discoverOperations()
      .catch((error) => {
        log('warn', `Couldn't read Spotify's operations (${(error as Error).message}); using known ones`)
        return operations.value
      })
      .then((value) => {
        if (value) setOperations(value)
      })
  }
  return operations.value
}

/* ------------------------------------------------------------------ *
 * GraphQL
 * ------------------------------------------------------------------ */

/** Run a GraphQL operation; returns its `data`. */
export async function gql(name: string, variables: Raw, attempt = 0): Promise<Raw> {
  const known = await ensureOperations(attempt === 2)
  const hash = known?.hashes?.[name] ?? KNOWN_OPERATIONS[name]
  if (!hash) throw new Error(`Spotify no longer has "${name}"`)

  const token = await accessToken({ fresh: attempt === 1 })
  const client = attempt === 0 ? await clientToken() : clientTokenValue?.token ?? null
  const response = await http.request(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      // Without it, Android's HTTP client sends "Dalvik/…", which Spotify answers with
      // 403 "Client/request not allowed".
      'user-agent': DESKTOP_UA,
      'app-platform': 'WebPlayer',
      ...(known?.appVersion ? { 'spotify-app-version': known.appVersion } : {}),
      ...(client ? { 'client-token': client } : {}),
      accept: 'application/json',
      'content-type': 'application/json;charset=UTF-8',
    },
    body: { variables, operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } },
  })

  const json = typeof response.data === 'object' && response.data !== null ? (response.data as Raw) : {}
  const message = String((json.errors as Raw[] | undefined)?.[0]?.message ?? '')
  if (response.status >= 400 || !json.data) {
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    log(
      'warn',
      `[gql] ${name} (attempt ${attempt}) → HTTP ${response.status}; session anonymous=${session.value?.anonymous}, ` +
        `appVersion=${known?.appVersion ?? 'none'}, hash ${known?.hashes?.[name] ? 'discovered' : 'built-in'}; ` +
        `www-authenticate=${response.headers['www-authenticate'] ?? '-'}; body: ${body.slice(0, 300)}`,
    )
  }
  if (response.status === 401 && attempt === 0) return gql(name, variables, 1)
  if (/PersistedQueryNotFound/i.test(message) && attempt < 2) return gql(name, variables, 2)
  if (response.status === 429 && attempt < 3) {
    await sleep(Math.min(Number(response.headers['retry-after']) || 2, 10) * 1000)
    return gql(name, variables, 3)
  }
  if (response.status >= 400 || !json.data) throw new Error(`Spotify: ${message || `HTTP ${response.status}`}`)
  return json.data
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

export async function refreshProfile(): Promise<Me | null> {
  if (session.value?.anonymous !== false) return null
  const data = await gql('profileAttributes', {})
  const profile = data?.me?.profile
  if (!profile) return null
  setMe({ id: String(profile.username ?? profile.uri), name: String(profile.name || profile.username), photo: largest(profile.avatar?.sources) })
  return me.value
}

/** A plain id from a "spotify:track:…" URI. */
export const idOf = (value: string) => String(value).split(':').pop() ?? ''

/** Headers every @webgate request carries, the way the web player's transport does. */
export async function gateHeaders(jsonBody = false): Promise<Record<string, string>> {
  const client = await clientToken()
  return {
    authorization: `Bearer ${await accessToken()}`,
    'app-platform': 'WebPlayer',
    'user-agent': DESKTOP_UA,
    ...(operations.value?.appVersion ? { 'spotify-app-version': operations.value.appVersion } : {}),
    ...(client ? { 'client-token': client } : {}),
    accept: 'application/json',
    ...(jsonBody ? { 'content-type': 'application/json;charset=UTF-8' } : {}),
  }
}

/** Guard against songs from other services reaching the stream resolver. */
export function trackIdOf(song: Song): string {
  const id = idOf(song.id)
  if (!id) throw new Error('This song has no Spotify track id')
  return id
}
