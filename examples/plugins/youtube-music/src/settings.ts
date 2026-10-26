import { account, canSignInNatively, refreshAccount, signedIn, signInWithCookie, signInWithGoogle, signOut, useAccountForContent } from './client'
import { Noctis, type SettingsBlock } from './host'

const { group } = Noctis
const { notify } = Noctis.libs.snackbar
const { showTextDialog } = Noctis.libs.ui

/**
 * Settings → YouTube Music: how the account is used. Signing in and out is in
 * Settings → Accounts, from `signInMethods` below (the service's `account`).
 */

function cookieSignIn() {
  showTextDialog({
    title: 'Sign in with a cookie',
    description:
      'Paste the Cookie header from a signed-in music.youtube.com request in a desktop browser (DevTools → Network). It must contain SAPISID. Treat it like a password.',
    placeholder: 'SAPISID=…; __Secure-3PAPISID=…; …',
    multiline: true,
    confirmLabel: 'Sign in',
    async onConfirm(value) {
      const ok = await signInWithCookie(value)
      notify(ok ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'That cookie has no SAPISID, so it cannot sign in.')
    },
  })
}

export const SECTION = {
  id: 'youtube-music',
  icon: 'account',
  title: 'YouTube Music',
  get description() {
    return signedIn.value ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Not signed in'
  },
}

/** For the service's `account`: what Settings → Accounts offers. */
export const accountActions = {
  signInMethods: [
    {
      id: 'google',
      label: 'Sign in with Google',
      description: 'Your YouTube Music library, likes and personal mixes',
      get hidden() {
        return !canSignInNatively
      },
      async run() {
        const ok = await signInWithGoogle()
        notify(ok ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Sign-in did not complete.')
      },
    },
    { id: 'cookie', icon: 'cookie', label: 'Sign in with a cookie', description: 'Advanced: paste a music.youtube.com cookie', run: cookieSignIn },
  ],
  signOut,
}

export const blocks: SettingsBlock[] = [
  group('account', [
    {
      id: 'account',
      icon: 'account',
      title: 'Account',
      get value() {
        return signedIn.value ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Not signed in · sign in'
      },
      chevron: true,
      onClick: () => void Noctis.libs.navigation.navigate({ name: 'settings-page', page: 'accounts' }),
    },
  ]),
  group(
    'signed-in',
    [
      {
        id: 'personalised',
        icon: 'manage-account',
        title: 'Personalised content',
        description: 'Use your account for home, search and radios',
        toggle: {
          get value() {
            return useAccountForContent.value
          },
          set(value: boolean) {
            useAccountForContent.value = value
          },
        },
      },
      { id: 'refresh', icon: 'sync', title: 'Refresh account info', onClick: () => void refreshAccount() },
    ],
    {
      get hidden() {
        return !signedIn.value
      },
    },
  ),
]
