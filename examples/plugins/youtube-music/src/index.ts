import type { PluginScope } from '../../plugins/runtime'
import type { ServiceDefinition } from '../types'
import { content, library } from './api'
import { account, playerInnertube, refreshAccount, sessionVersion, signedIn, useAccountForContent } from './client'
import { prewarmPoToken } from './potoken'
import { blocks, SECTION } from './settings'
import { resolveStream } from './stream'
import { resizeThumbnail } from './thumbnails'

/**
 * YouTube Music, as a plugin. It ships with the app (so it can use youtubei.js and
 * BotGuard from the bundle, and is loaded as its own chunk), but it plugs in exactly
 * like an installed plugin would: one `defineService` plus a settings section, both
 * undone when it's disabled in Settings → Plugins.
 */

export const ID = 'youtube-music'

const service: ServiceDefinition = {
  name: 'YouTube Music',
  icon: 'music',
  ...content,
  // Library endpoints exist only with an account; without them the app shows
  // on-device likes and history instead.
  get library() {
    return signedIn.value ? library : undefined
  },
  streams: { resolve: resolveStream },
  thumbnails: { resize: resizeThumbnail },
  account: {
    get signedIn() {
      return signedIn.value
    },
    get info() {
      return account.value
    },
    get sessionKey() {
      return `${signedIn.value && useAccountForContent.value ? 'account' : 'guest'}:${sessionVersion.value}`
    },
    section: SECTION.id,
    signInTitle: 'Sign in to YouTube Music',
    signInDescription: 'Get your playlists, likes and personal mixes',
    refresh: refreshAccount,
  },
}

export default function youtubeMusic({ Plugin }: PluginScope) {
  let warmup = 0

  const attach = () => {
    Plugin.defineService(ID, service)
    Plugin.defineSection(SECTION, blocks, 0)
    if (signedIn.value && !account.value) void refreshAccount()
    // Loading YouTube's player script and BotGuard takes a few seconds; do it before the
    // first tap on a song rather than after.
    warmup = window.setTimeout(() => {
      void playerInnertube().catch(() => {})
      prewarmPoToken()
    }, 1500)
  }

  const detach = () => {
    window.clearTimeout(warmup)
    Plugin.removeService(ID)
    Plugin.removeSection(SECTION.id)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
