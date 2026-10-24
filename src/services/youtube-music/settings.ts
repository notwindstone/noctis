import { group, type SettingsBlock } from '../../plugins/rows'
import { notify } from '../../snackbar'
import { confirm, showTextDialog } from '../../ui'
import AccountHero from './AccountHero.vue'
import { account, refreshAccount, signedIn, signInWithCookie, signOut, useAccountForContent } from './client'

/** Settings → YouTube Music: the account. Getter-based rows, like the app's own. */

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

function confirmSignOut() {
  confirm({
    title: 'Sign out?',
    message: 'Your downloads, likes and history on this device stay where they are.',
    confirmLabel: 'Sign out',
    destructive: true,
    onConfirm: async () => {
      await signOut()
      notify('Signed out')
    },
  })
}

export const SECTION = {
  id: 'youtube-music',
  icon: 'account',
  title: 'YouTube Music',
  get description() {
    return signedIn.value ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Account and sign-in'
  },
}

export const blocks: SettingsBlock[] = [
  { id: 'hero', type: 'component', component: AccountHero },
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
  group('sign-out', [{ id: 'sign-out', icon: 'logout', title: 'Sign out', destructive: true, onClick: confirmSignOut }], {
    get hidden() {
      return !signedIn.value
    },
  }),
  group(
    'cookie',
    [
      {
        id: 'cookie',
        icon: 'cookie',
        title: 'Sign in with a cookie',
        description: 'Advanced: paste a music.youtube.com cookie',
        onClick: cookieSignIn,
      },
    ],
    {
      get hidden() {
        return signedIn.value
      },
    },
  ),
]
