import { computed, ref, watch } from 'vue'
import { Innertube, Log, Platform, UniversalCache } from 'youtubei.js'
import { Noctis, type AccountInfo } from './host'
import { ytFetch } from './http'

const { hasNoctisPlugin, Noctis: native } = Noctis.libs.native
const { contentCountry, contentLanguage } = Noctis.libs.preferences
const { isBoolean, persisted } = Noctis.libs.storage

Log.setLevel(Log.Level.NONE)

// Stream URLs are deciphered by running functions extracted from YouTube's player
// script. A Capacitor WebView has no CSP, so a plain Function constructor is enough.
Platform.shim.eval = (data) => new Function(data.output)()

export interface AuthState {
  cookie: string
  visitorData?: string
}

export const auth = persisted<AuthState | null>('noctis:auth', null, (value) => value === null || typeof value === 'object')
export const account = persisted<AccountInfo | null>('noctis:account', null)
/** Use the account for home/search results, not just for library features. */
export const useAccountForContent = persisted('noctis:account-content', true, isBoolean)

export const signedIn = computed(() => Boolean(auth.value?.cookie && /(^|;\s*)SAPISID=/.test(auth.value.cookie)))

/**
 * Bumped whenever the session changes (sign in/out, language, region) so screens know
 * to reload their content.
 */
export const sessionVersion = ref(0)

let browseSession: Promise<Innertube> | null = null
let playerSession: Promise<Innertube> | null = null

/** Persisted across launches so recommendations stay consistent for signed-out users. */
const visitorData = persisted<string>('noctis:visitor', '', (value) => typeof value === 'string')

function create(retrievePlayer: boolean): Promise<Innertube> {
  const cookie = signedIn.value && useAccountForContent.value ? auth.value?.cookie : undefined

  const session = Innertube.create({
    fetch: ytFetch,
    lang: contentLanguage.value,
    location: contentCountry.value,
    cookie,
    visitor_data: auth.value?.visitorData || visitorData.value || undefined,
    retrieve_player: retrievePlayer,
    cache: retrievePlayer ? new UniversalCache(true) : undefined,
    generate_session_locally: false,
  })

  session
    .then((yt) => {
      const fresh = yt.session.context.client.visitorData
      if (fresh && !visitorData.value) visitorData.value = fresh
    })
    .catch(() => {})

  return session
}

/** Session for browsing: home, search, library, pages. */
export function innertube(): Promise<Innertube> {
  browseSession ??= create(false).catch((error) => {
    browseSession = null
    throw error
  })
  return browseSession
}

/** Session that also loaded YouTube's player script, needed to resolve stream URLs. */
export function playerInnertube(): Promise<Innertube> {
  playerSession ??= create(true).catch((error) => {
    playerSession = null
    throw error
  })
  return playerSession
}

export function resetSessions() {
  browseSession = null
  playerSession = null
  sessionVersion.value++
}

watch([() => auth.value?.cookie, useAccountForContent, contentLanguage, contentCountry], resetSessions)

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

export const canSignInNatively = hasNoctisPlugin

/** Opens the native Google sign-in page. Resolves to true when signed in. */
export async function signInWithGoogle(): Promise<boolean> {
  if (!hasNoctisPlugin) return false
  const result = await native.openLogin()
  return signInWithCookie(result.cookie, result.visitorData)
}

/** Advanced: sign in with a cookie string copied from a desktop browser session. */
export async function signInWithCookie(cookie: string, visitor?: string): Promise<boolean> {
  const trimmed = cookie.trim().replace(/^cookie:\s*/i, '')
  if (!/(^|;\s*)SAPISID=/.test(trimmed)) return false

  auth.value = { cookie: trimmed, visitorData: visitor || undefined }
  account.value = null
  await refreshAccount()
  return true
}

export async function signOut() {
  auth.value = null
  account.value = null
  if (hasNoctisPlugin) {
    await native.clearCookies().catch(() => {})
  }
}

interface AccountMenuJson {
  actions?: {
    openPopupAction?: {
      popup?: {
        multiPageMenuRenderer?: {
          header?: {
            activeAccountHeaderRenderer?: {
              accountName?: { runs?: { text: string }[] }
              channelHandle?: { runs?: { text: string }[] }
              accountPhoto?: { thumbnails?: { url: string }[] }
            }
          }
        }
      }
    }
  }[]
}

export async function refreshAccount(): Promise<AccountInfo | null> {
  if (!signedIn.value) return null
  try {
    const yt = await innertube()
    const response = await yt.actions.execute('/account/account_menu', { client: 'YTMUSIC' })
    const json = response.data as unknown as AccountMenuJson
    const header = json.actions?.[0]?.openPopupAction?.popup?.multiPageMenuRenderer?.header?.activeAccountHeaderRenderer
    if (!header?.accountName?.runs?.[0]) return account.value

    account.value = {
      name: header.accountName.runs.map((run) => run.text).join(''),
      handle: header.channelHandle?.runs?.map((run) => run.text).join(''),
      photo: header.accountPhoto?.thumbnails?.at(-1)?.url,
    }
    return account.value
  } catch {
    return account.value
  }
}
