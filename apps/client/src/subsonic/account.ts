import type { ServiceAccount, SignInMethod } from '../services/types'
import { handshake, otherServerName, serverKind, serverUrl, signIn, signInWithApiKey, signInWithPassword, signOut } from '../server'
import { notify } from '../snackbar'
import { showTextDialog } from '../ui'
import { credentials, guestAccess } from './client'

/**
 * The connected server's account, for Settings → Accounts and for the server as a
 * service. Noctis servers: username and password, exchanged for a session. Other
 * OpenSubsonic servers: an API key first, else username and password (Subsonic token
 * auth, the password never stored).
 */

/** OpenSubsonic servers name their type in lower case ("navidrome"). */
const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

export const serverName = () => handshake.value?.server.name ?? (otherServerName.value ? capitalized(otherServerName.value) : serverUrl.value.replace(/^https?:\/\//, '') || 'Server')

/** Username, then password: the text dialog has one field. */
function askUsernameAndPassword(description: string, passwordNote: string, submit: (username: string, password: string) => Promise<void>) {
  showTextDialog({
    title: `Sign in to ${serverName()}`,
    description,
    placeholder: 'Username',
    confirmLabel: 'Next',
    onConfirm(username) {
      const name = username.trim()
      if (!name) return
      showTextDialog({
        title: `Password for ${name}`,
        description: passwordNote,
        placeholder: 'Password',
        password: true,
        confirmLabel: 'Sign in',
        async onConfirm(password) {
          try {
            await submit(name, password)
            notify(`Signed in to ${serverName()} as ${name}`)
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error))
          }
        },
      })
    },
  })
}

const methods: SignInMethod[] = [
  {
    id: 'session',
    label: 'Sign in',
    description: 'Your account on this server',
    get hidden() {
      return serverKind.value !== 'noctis'
    },
    run: () => askUsernameAndPassword(`Your account on ${serverName()}.`, "Exchanged for a session; the password isn't kept on this device.", signIn),
  },
  {
    id: 'api-key',
    icon: 'fingerprint',
    label: 'Sign in with an API key',
    description: 'Preferred: create one in the server’s settings (OpenSubsonic API keys)',
    get hidden() {
      return serverKind.value !== 'opensubsonic'
    },
    run() {
      showTextDialog({
        title: 'Sign in with an API key',
        description: `Create an API key in ${serverName()}'s settings and paste it here. Servers without API keys can use a username and password instead.`,
        placeholder: 'API key',
        confirmLabel: 'Sign in',
        async onConfirm(key) {
          try {
            await signInWithApiKey(key)
            notify(`Signed in to ${serverName()}`)
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error))
          }
        },
      })
    },
  },
  {
    id: 'password',
    icon: 'password',
    label: 'Sign in with username and password',
    description: 'For servers without API keys (Navidrome’s demo, older Subsonic servers)',
    get hidden() {
      return serverKind.value !== 'opensubsonic'
    },
    run: () =>
      askUsernameAndPassword(
        `Your account on ${serverName()}. Use an API key instead if the server offers them.`,
        'Only a salted hash of it is kept (Subsonic token auth), never the password itself.',
        signInWithPassword,
      ),
  },
]

export const serverAccount: ServiceAccount = {
  get signedIn() {
    return credentials.value !== null
  },
  get info() {
    const auth = credentials.value
    if (!auth) return null
    const how = serverKind.value === 'noctis' ? 'session' : 'apiKey' in auth ? 'API key' : 'username and password'
    return { name: auth.username, handle: `${serverUrl.value.replace(/^https?:\/\//, '')} · ${how}` }
  },
  get sessionKey() {
    return `${serverUrl.value}|${credentials.value?.username ?? ''}`
  },
  section: 'server',
  get signInTitle() {
    return `Sign in to ${serverName()}`
  },
  get signInDescription() {
    return guestAccess.value ? 'Optional: you can listen as a guest. Sign in for your library, playlists and likes' : 'Your library, playlists and recommendations'
  },
  signInMethods: methods,
  signOut: () => signOut(),
}
