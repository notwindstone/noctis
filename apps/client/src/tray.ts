import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { shallowReactive, watch } from 'vue'
import { isDesktop } from './native'
import { isLiked, toggleLike } from './library'
import { currentSong, isPlaying, next, previous, togglePlay } from './player'
import { runBeforeHooks } from './plugins/hooks'
import { writeLog } from './plugins/log'
import { minimizeToTray } from './preferences'

/**
 * The system tray (desktop app): an icon that stays while the window is closed, with a
 * menu (Show, Play/Pause, Previous, Next, Like, then plugins' items, Quit). Whether closing the
 * window minimizes to it is Settings → Appearance → "Minimize to tray"; src-tauri/src/tray.rs
 * draws it. Plugins add menu items (`registerTrayItem`) and can take over a left click
 * with the `onTrayClick` hook.
 */

export interface TrayItem {
  id: string
  label: string
  onClick(): void | Promise<void>
}

const items = shallowReactive<Record<string, TrayItem>>({})

/** Add an item to the tray menu. Returns a function that removes it. Ids are the caller's to keep unique. */
export function registerTrayItem(item: TrayItem): () => void {
  const id = `plugin:${item.id}`
  items[id] = { ...item, id }
  return () => {
    delete items[id]
  }
}

/** "Add to liked songs" for what plays now; not offered while nothing is loaded. */
const LIKE_ID = '__like'

function builtInItems(): { id: string; label: string }[] {
  const song = currentSong.value
  if (!song) return []
  return [{ id: LIKE_ID, label: isLiked(song.id) ? 'Remove from liked songs' : 'Add to liked songs' }]
}

const allItems = () => [...builtInItems(), ...Object.values(items).map(({ id, label }) => ({ id, label }))]

async function run(id: string) {
  switch (id) {
    case LIKE_ID: {
      const song = currentSong.value
      if (song) await toggleLike(song)
      return
    }
    case '__toggle':
      return togglePlay()
    case '__previous':
      return previous()
    case '__next':
      return next()
  }
  try {
    await items[id]?.onClick()
  } catch (error) {
    writeLog('noctis', 'error', `Tray item "${id}" threw:`, error)
  }
}

export function initTray() {
  if (!isDesktop) return

  // The tray follows the setting, the menu what plugins added and whether music plays.
  watch(
    [minimizeToTray, isPlaying, () => allItems().map((item) => `${item.id}\n${item.label}`).join('\u0000')],
    () => {
      void invoke('set_tray', {
        enabled: minimizeToTray.value,
        playing: isPlaying.value,
        items: allItems(),
      }).catch((error) => writeLog('noctis', 'warn', "Couldn't update the tray:", error))
    },
    { immediate: true },
  )

  void listen<string>('tray-menu', (event) => void run(event.payload))
  void listen('tray-click', async () => {
    // A plugin that stops the hook handles the click; otherwise it brings the window back.
    const outcome = await runBeforeHooks('onTrayClick', {})
    if (!outcome.stopped) await invoke('show_main_window')
  })
}
