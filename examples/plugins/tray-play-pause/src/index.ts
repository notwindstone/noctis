import type { PluginScope } from './host'

/**
 * Tray play/pause: a left click on the desktop tray icon toggles playback, a double click
 * opens Noctis (the `onTrayClick` hook). The toggle waits a moment to see whether a second
 * click follows, so opening the window from the tray doesn't pause the music first.
 * Nothing loaded: clicks aren't taken, so they open the window like they do without this
 * plugin. Needs "Minimize to tray" (Settings → Appearance), which is what shows the icon.
 */

/** A second click within this many milliseconds is a double click. */
const DOUBLE_CLICK_MS = 350

export default function trayPlayPause({ Plugin, Noctis }: PluginScope) {
  const { player } = Noctis.libs
  let pending: ReturnType<typeof setTimeout> | undefined

  const onClick = () => {
    if (pending !== undefined) {
      // The second click: no pause, and the app brings the window back.
      clearTimeout(pending)
      pending = undefined
      return
    }
    if (!player.currentSong.value) return
    pending = setTimeout(() => {
      pending = undefined
      void player.togglePlay()
    }, DOUBLE_CLICK_MS)
    return { status: 'stop' as const }
  }

  const attach = () => Plugin.subscribe('hook::onTrayClick::before', onClick)
  const detach = () => {
    clearTimeout(pending)
    pending = undefined
    Plugin.unsubscribe('hook::onTrayClick::before', onClick)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  Plugin.log('Tray icon: click plays or pauses, double click opens Noctis.')
}
