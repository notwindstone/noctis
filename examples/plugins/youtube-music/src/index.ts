import type { PluginScope, ServiceDefinition } from './host'
import { content, library } from './api'
import { account, playerInnertube, refreshAccount, sessionVersion, signedIn, useAccountForContent } from './client'
import { prewarmPoToken } from './potoken'
import { accountActions, blocks, SECTION } from './settings'
import { Noctis } from './host'
import { resolveStream } from './stream'
import { resizeThumbnail } from './thumbnails'

/**
 * YouTube Music, as a plugin: one `defineService` plus a settings section, both undone
 * when it's disabled in Settings → Plugins. Written in TypeScript with npm packages
 * (youtubei.js, BotGuard), so `npm run pack-plugin` builds it into a single index.js.
 *
 * It also plays songs from elsewhere by finding them here (Noctis.libs.matching): a
 * server's songs known only from MusicBrainz, SoundCloud tracks… get a "YouTube Music"
 * option in Play from. Spotify songs are skipped: that plugin matches them itself.
 */

const ID = 'youtube-music'

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
    ...accountActions,
  },
}

export default function youtubeMusic({ Plugin }: PluginScope) {
  let warmup = 0
  let stopMatching: (() => void) | null = null

  const attach = () => {
    Plugin.defineService(ID, service)
    Plugin.defineSection(SECTION, blocks, 0)
    stopMatching ??= Noctis.libs.matching.offerAsSource(ID, { skip: ['spotify'] })
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
    stopMatching?.()
    stopMatching = null
    Plugin.removeService(ID)
    Plugin.removeSection(SECTION.id)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
