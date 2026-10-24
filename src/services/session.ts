import { computed, watch } from 'vue'
import type { AccountInfo } from '../models'
import { navigate } from '../navigation'
import { contentCountry, contentLanguage } from '../preferences'
import { supports } from './api'
import { activeService, areServicesReady } from './registry'

/**
 * The active service's account, for the parts of the UI that show one (the settings
 * card, avatars, "sign in" prompts). Services without accounts read as signed out.
 */

const currentAccount = computed(() => activeService.value?.service.account ?? null)

export const signedIn = computed(() => currentAccount.value?.signedIn ?? false)
export const account = computed<AccountInfo | null>(() => (signedIn.value ? (currentAccount.value?.info ?? null) : null))
export const serviceName = computed(() => activeService.value?.service.name ?? 'No service')
/** The active service can have an account at all. */
export const hasAccounts = computed(() => currentAccount.value !== null)
/** The active service has a library of saved playlists (YouTube Music: when signed in). */
export const hasLibrary = computed(() => supports(activeService.value?.id, 'library.playlists'))
/** The active service keeps liked songs of its own. */
export const syncsLikes = computed(() => supports(activeService.value?.id, 'library.liked'))

/**
 * Identifies what content looks like right now: which service, whose account, which
 * language and region. Screens refetch when it changes; cached pages are tied to it.
 */
export const sessionKey = computed(() =>
  [activeService.value?.id ?? '', currentAccount.value?.sessionKey ?? '', contentLanguage.value, contentCountry.value].join('|'),
)

export const signInTitle = computed(() => currentAccount.value?.signInTitle ?? `Sign in to ${serviceName.value}`)
export const signInDescription = computed(() => currentAccount.value?.signInDescription ?? 'Get your playlists, likes and mixes')

/**
 * Run `callback` when the session changes (call it in a component's setup). Changes
 * while startup plugins are still defining services don't count: screens load their
 * cached pages once services are ready instead.
 */
export function onSessionChange(callback: () => void) {
  watch(sessionKey, () => {
    if (areServicesReady()) callback()
  })
}

/** Open the settings section where the active service's account is managed. */
export function openAccountSettings() {
  const section = currentAccount.value?.section
  void navigate({ name: 'settings-page', page: section ?? 'plugins' })
}

export function refreshAccount(): Promise<unknown> {
  return currentAccount.value?.refresh?.().catch(() => null) ?? Promise.resolve(null)
}
