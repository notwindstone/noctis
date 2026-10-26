import { computed, shallowReactive } from 'vue'
import { services } from './services/registry'
import type { ServiceAccount } from './services/types'

/**
 * Every account in one place (Settings → Accounts): each service's (`account` in its
 * definition, with its sign-in methods), plus accounts that exist without a service,
 * like a server you're connected to but not signed in to (`registerAccount`). An entry
 * registered under a service's id replaces that service's own.
 */

export interface AccountEntry {
  readonly name: string
  readonly icon?: string
  readonly account: ServiceAccount
  readonly hidden?: boolean
}

const registered = shallowReactive<Record<string, AccountEntry>>({})

export function registerAccount(id: string, entry: AccountEntry) {
  registered[id] = entry
  return () => {
    if (registered[id] === entry) delete registered[id]
  }
}

/** id → entry, services first (in the order they were defined), then registered ones. */
export const accountEntries = computed<[string, AccountEntry][]>(() => {
  const list: [string, AccountEntry][] = []
  for (const [id, service] of Object.entries(services)) {
    if (registered[id] || !service.account) continue
    const account = service.account
    list.push([id, { get name() { return service.name }, icon: service.icon, account }])
  }
  for (const [id, entry] of Object.entries(registered)) if (!entry.hidden) list.push([id, entry])
  return list
})

export const signedInCount = computed(() => accountEntries.value.filter(([, entry]) => entry.account.signedIn).length)
