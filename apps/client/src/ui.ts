import { ref, shallowRef } from 'vue'
import type { IconName } from './icons'
import type { Item, Song } from './models'

/** Full player: true when expanded (or expanding), false when collapsed to the mini player. */
export const playerExpanded = ref(false)
/** 0 = mini player, 1 = full screen. Driven by PlayerSheet's drag and animations. */
export const playerExpansion = ref(0)

export function openPlayer() {
  playerExpanded.value = true
}

export function closePlayer() {
  playerExpanded.value = false
}

/**
 * Artwork and controls side by side, the queue beside them: wide windows, and phones in
 * landscape (too short to stack them). main.css repeats this query for the layout.
 */
export const SIDE_BY_SIDE_PLAYER = '(min-width: 900px) and (min-aspect-ratio: 6 / 5), (orientation: landscape) and (max-height: 600px)'

/**
 * Open a website outside the app: the system browser on Android and desktops (main.ts sends
 * desktop links there), a new tab in a browser.
 */
export function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return
  Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener noreferrer' }).click()
}

/** The "Up next" panel inside the full player. */
export const queueOpen = ref(false)

export interface ItemMenuRequest {
  item: Item
  /** A list the song came from, offered as "Play from here". */
  list?: { songs: Song[]; index: number; title: string }
  /** Extra action, e.g. "Remove from queue". */
  queueIndex?: number
  /** The playlist of yours the song is listed in: offers "Remove from this playlist". */
  playlist?: { id: string; source?: string }
  /** Opened with a mouse: show a menu at this point (viewport pixels) instead of the bottom sheet. */
  at?: { x: number; y: number; above?: number }
}

/**
 * Where a menu opened by `event` should appear: at the pointer for a mouse (a right click,
 * or a ⋮ button clicked: just below it), nowhere (the bottom sheet) for touch and pens.
 */
export function menuPoint(event: MouseEvent | undefined): ItemMenuRequest['at'] {
  if (!event) return undefined
  const type = (event as PointerEvent).pointerType
  const mouse = type ? type === 'mouse' : window.matchMedia('(pointer: fine)').matches
  if (!mouse) return undefined
  // A keyboard "click" (Enter on ⋮) has no pointer position: open under the button.
  const button = (event.target as Element | null)?.closest('button')
  if (event.type === 'click' && button) {
    const box = button.getBoundingClientRect()
    return { x: box.left, y: box.bottom + 4, above: box.top - 4 }
  }
  return { x: event.clientX, y: event.clientY }
}

export const itemMenu = shallowRef<ItemMenuRequest | null>(null)

export function showItemMenu(request: ItemMenuRequest) {
  itemMenu.value = request
}

/**
 * A list to pick from; choosing closes it. With `value` set to one of the options it's a
 * setting (radio buttons mark the current one); with none of them (e.g. '') the options
 * are actions, shown with their icons and no radio buttons.
 */
export interface ChoiceDialog<T extends string = string> {
  title: string
  options: { value: T; label: string; description?: string; icon?: IconName }[]
  value: T
  onSelect: (value: T) => void
}

export const choiceDialog = shallowRef<ChoiceDialog | null>(null)

export function showChoice<T extends string>(dialog: ChoiceDialog<T>) {
  choiceDialog.value = dialog as unknown as ChoiceDialog
}

export interface PlayFromRequest {
  /** The song to choose for (the player's); null: only the preference for every song (Settings). */
  song: Song | null
}

/** The Play from dialog (src/components/PlayFromDialog.vue), the same from Settings and the player. */
export const playFromDialog = shallowRef<PlayFromRequest | null>(null)

export function showPlayFrom(request: PlayFromRequest) {
  playFromDialog.value = request
}

export interface TextDialog {
  title: string
  description?: string
  placeholder?: string
  multiline?: boolean
  /** Text the field starts with (renaming). */
  initial?: string
  /** Hide what's typed (passwords). */
  password?: boolean
  /** Start sentences with a capital on phone keyboards (names); off for URLs, usernames, codes. */
  capitalize?: boolean
  confirmLabel?: string
  onConfirm: (value: string) => void | Promise<void>
}

export const textDialog = shallowRef<TextDialog | null>(null)

export function showTextDialog(dialog: TextDialog) {
  textDialog.value = dialog
}

export interface ConfirmDialog {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}

export const confirmDialog = shallowRef<ConfirmDialog | null>(null)

export function confirm(dialog: ConfirmDialog) {
  confirmDialog.value = dialog
}
