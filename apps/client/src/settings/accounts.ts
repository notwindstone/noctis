import { watch } from 'vue'
import AccountHeader from '../components/settings/AccountHeader.vue'
import { accountEntries, signedInCount, type AccountEntry } from '../accounts'
import { navigate } from '../navigation'
import { defineSection, group, Rows, type SettingsBlock, type SettingsRowDef } from '../plugins/rows'
import { notify } from '../snackbar'
import { confirm } from '../ui'

/**
 * Settings → Accounts: every account, the same way. Each shows who's signed in, the
 * service's sign-in methods while signed out, "Sign out", and the service's own
 * settings page if it has more. Services describe this in `account` (signInMethods,
 * signOut); nothing here is service-specific.
 */

export const ACCOUNTS_SECTION = 'accounts'

function blocksFor(id: string, entry: AccountEntry): SettingsBlock[] {
  const account = entry.account
  const methods = (account.signInMethods ?? []).map(
    (method): SettingsRowDef => ({
      id: `sign-in:${method.id}`,
      icon: method.icon ?? 'login',
      title: method.label,
      description: method.description,
      get hidden() {
        return account.signedIn || Boolean(method.hidden)
      },
      async onClick() {
        try {
          await method.run()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/cancel/i.test(message)) notify(message)
        }
      },
    }),
  )
  const rows: SettingsRowDef[] = [
    ...methods,
    {
      id: 'no-methods',
      icon: 'info',
      title: 'Sign in from its settings',
      get hidden() {
        return account.signedIn || methods.length > 0 || !account.section
      },
      chevron: true,
      onClick: () => void navigate({ name: 'settings-page', page: account.section! }),
    },
    {
      id: 'sign-out',
      icon: 'logout',
      title: 'Sign out',
      destructive: true,
      get hidden() {
        return !account.signedIn || !account.signOut
      },
      onClick() {
        confirm({
          title: `Sign out of ${entry.name}?`,
          message: 'Likes, downloads and history on this device stay where they are.',
          confirmLabel: 'Sign out',
          destructive: true,
          onConfirm: async () => {
            await account.signOut?.()
            notify(`Signed out of ${entry.name}`)
          },
        })
      },
    },
    {
      id: 'settings',
      icon: 'settings',
      // The name can change after the page is built (a server's, once it answers).
      get title() {
        return `${entry.name} settings`
      },
      chevron: true,
      get hidden() {
        return !account.section || account.section === ACCOUNTS_SECTION
      },
      onClick: () => void navigate({ name: 'settings-page', page: account.section! }),
    },
  ]
  return [
    { id: `${id}:header`, type: 'component', component: AccountHeader, props: { entryId: id } },
    group(`${id}:rows`, rows),
  ]
}

export function defineAccountSettings() {
  defineSection(
    {
      id: ACCOUNTS_SECTION,
      icon: 'account',
      title: 'Accounts',
      get description() {
        const total = accountEntries.value.length
        return total === 0 ? 'No services with accounts' : `${signedInCount.value} of ${total} signed in`
      },
      // Opened from the account card at the top of Settings.
      hidden: true,
    },
    [],
    'noctis',
  )

  // Rebuild when accounts come and go (plugins enabled, a server connected).
  watch(
    () => accountEntries.value.map(([id]) => id).join('\n'),
    () => {
      const blocks: SettingsBlock[] = accountEntries.value.flatMap(([id, entry]) => blocksFor(id, entry))
      if (blocks.length === 0) blocks.push({ id: 'empty', type: 'note', text: 'No account yet: services from plugins (YouTube Music, SoundCloud…) and servers you connect to show their accounts here.' })
      else blocks.push({ id: 'note', type: 'note', text: 'Each service keeps its own account. Signing in here is the same as in the service’s settings.' })
      const list = Rows[ACCOUNTS_SECTION]
      if (list) list.splice(0, list.length, ...blocks)
    },
    { immediate: true },
  )
}
