import { clearCache, load, startFollowing } from './engine'
import type { ActionEntry, PluginScope } from './host'
import { buildSettings, SECTION } from './settingsPage'
import { openFullscreen, closeFullscreen, Overlay, PlayerArt } from './screens'
import { initState, settings, sources, view } from './state'
import { css } from './styles'
import { registerRomanizer, registerTranslator } from './translate'
import type { LyricsSource } from './types'

/**
 * Lyrics: synced lyrics in the full player, in place of the cover. Tap them to open the
 * full-screen view. Sources, translation, romanization and every animation are settings.
 *
 * - engine.ts finds lyrics (all sources at once, best one wins) and translates them;
 * - view.ts draws them: word fill, blur, spring scrolling;
 * - screens.ts is the cover replacement (`PlayerArt`) and the full-screen overlay;
 * - other plugins can add sources, translators and romanizers through `Noctis.lyrics`.
 */

/** Material "fullscreen" (corner brackets), for the button on the lyrics card. */
const EXPAND_ICON = 'M120-120v-240h80v160h160v80H120Zm480 0v-80h160v-160h80v240H600ZM120-600v-240h240v80H200v160h-80Zm640 0v-160H600v-80h240v240h-80Z'

export default function lyrics({ Plugin, Noctis }: PluginScope) {
  const { createApp } = Noctis.packages.vue
  const stopSettings = initState(Plugin)

  let style: HTMLStyleElement | null = null
  let host: HTMLElement | null = null
  let app: ReturnType<typeof createApp> | null = null
  let stopFollowing: (() => void) | null = null
  let unregisterBack: (() => void) | null = null
  const stopWatch: (() => void)[] = []
  const added: (() => void)[] = []

  const playerEntry = {
    id: 'lyrics',
    icon: 'lyrics',
    label: 'Lyrics',
    action: 'lyrics.open',
    visible: () => settings.enabled,
    filled: () => view.fullscreen,
  }

  /** What other plugins can use: `Noctis.lyrics`. */
  const api = {
    registerSource(source: LyricsSource) {
      sources.set(source.id, source)
      return () => void (sources.get(source.id) === source && sources.delete(source.id))
    },
    registerTranslator,
    registerRomanizer,
    current: () => view.lyrics,
    open: openFullscreen,
    reload: () => load(Noctis.libs.player.currentSong.value, true),
  }

  function attach() {
    style = document.createElement('style')
    style.dataset.plugin = Plugin.id
    style.textContent = css
    document.head.appendChild(style)

    Noctis.registerIcon('lyr-expand', EXPAND_ICON)
    Plugin.registerComponent('PlayerArt', PlayerArt)

    host = document.createElement('div')
    host.dataset.plugin = Plugin.id
    document.body.appendChild(host)
    app = createApp(Overlay)
    app.mount(host)

    unregisterBack = Noctis.libs.back.registerBackTarget({
      priority: 15,
      enabled: () => view.fullscreen,
      onInvoke: closeFullscreen,
    })

    Plugin.registerAction('lyrics.open', () => {
      if (view.fullscreen) closeFullscreen()
      else openFullscreen()
    })
    Noctis.ActionCollections.playerActions.push(playerEntry as ActionEntry)

    Plugin.defineSection(SECTION, buildSettings())
    ;(Noctis as unknown as { lyrics?: typeof api }).lyrics = api

    stopFollowing = startFollowing()
    // The overlay is only for the song that plays: closing the player ends it too.
    stopWatch.push(
      Noctis.packages.vue.watch(
        () => Noctis.libs.player.currentSong.value,
        (song) => {
          if (!song) closeFullscreen()
        },
      ),
    )
  }

  function detach() {
    closeFullscreen()
    stopFollowing?.()
    stopFollowing = null
    stopWatch.splice(0).forEach((stop) => stop())
    unregisterBack?.()
    unregisterBack = null
    added.splice(0).forEach((undo) => undo())
    app?.unmount()
    app = null
    host?.remove()
    host = null
    style?.remove()
    style = null
    Plugin.restoreComponent('PlayerArt')
    Plugin.unregisterAction('lyrics.open')
    const list = Noctis.ActionCollections.playerActions
    const at = list.indexOf(playerEntry as ActionEntry)
    if (at !== -1) list.splice(at, 1)
    Plugin.removeSection(SECTION.id)
    delete (Noctis as unknown as { lyrics?: typeof api }).lyrics
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  void stopSettings
  void clearCache
  Plugin.log('Lyrics is ready. Settings → Lyrics has the sources, translation and animation options.')
}
