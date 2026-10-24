import { haptic } from './haptics'
import { openItem } from './navigation'
import { playRadio, playSong, playSongs } from './player'
import { showItemMenu } from './ui'
import type { Item, Song } from './models'

/**
 * Event delegation for lists of songs, albums, playlists and artists.
 *
 * Rows (ItemRow) and cards (ItemCard) carry no listeners of their own; they only mark
 * themselves with `data-item-index` and their buttons with `data-action`. The list
 * container gets one click and one contextmenu handler from here, so an 800-song
 * playlist costs two listeners instead of a few thousand.
 */
export interface ItemListContext {
  items: Item[]
  /**
   * 'list': tapping a song plays this list's songs starting from it (albums,
   * playlists, filtered search). 'radio': plays the song followed by its radio
   * (home rows, mixed search results).
   */
  play?: 'list' | 'radio'
  /** Shown as "Playing from …". */
  title?: string
}

/** Events already handled by an inner list, so an outer one doesn't act on them too. */
const handled = new WeakSet<Event>()

export function useItemDelegation(context: () => ItemListContext) {
  function locate(event: Event) {
    if (handled.has(event)) return null
    const target = event.target as Element | null
    const element = target?.closest<HTMLElement>('[data-item-index]')
    if (!element || !(event.currentTarget as Element).contains(element)) return null

    const { items } = context()
    const item = items[Number(element.dataset.itemIndex)]
    if (!item) return null

    handled.add(event)
    return { item, action: target?.closest<HTMLElement>('[data-action]')?.dataset.action }
  }

  function songList(item: Song) {
    const { items, play, title } = context()
    if (play !== 'list') return undefined
    const songs = items.filter((entry): entry is Song => entry.type === 'song')
    return { songs, index: Math.max(0, songs.indexOf(item)), title: title ?? '' }
  }

  function activate(item: Item) {
    haptic('tap')
    if (item.type === 'song') {
      const list = songList(item)
      if (list) playSongs(list.songs, list.index, list.title)
      else void playSong(item)
    } else if (item.type === 'playlist' && item.radio) {
      void playRadio(item)
    } else {
      void openItem(item)
    }
  }

  function menu(item: Item, longPress: boolean) {
    haptic(longPress ? 'longPress' : 'tap')
    showItemMenu({ item, list: item.type === 'song' ? songList(item) : undefined })
  }

  return {
    onClick(event: MouseEvent) {
      const hit = locate(event)
      if (!hit?.action) return
      if (hit.action === 'menu') menu(hit.item, false)
      else if (hit.action === 'open') activate(hit.item)
    },
    onContextmenu(event: MouseEvent) {
      const hit = locate(event)
      if (!hit) return
      event.preventDefault()
      menu(hit.item, true)
    },
  }
}
