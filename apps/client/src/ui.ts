import { ref, shallowRef } from 'vue'
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

/** The "Up next" panel inside the full player. */
export const queueOpen = ref(false)

export interface ItemMenuRequest {
  item: Item
  /** A list the song came from, offered as "Play from here". */
  list?: { songs: Song[]; index: number; title: string }
  /** Extra action, e.g. "Remove from queue". */
  queueIndex?: number
}

export const itemMenu = shallowRef<ItemMenuRequest | null>(null)

export function showItemMenu(request: ItemMenuRequest) {
  itemMenu.value = request
}

export interface ChoiceDialog<T extends string = string> {
  title: string
  options: { value: T; label: string; description?: string }[]
  value: T
  onSelect: (value: T) => void
}

export const choiceDialog = shallowRef<ChoiceDialog | null>(null)

export function showChoice<T extends string>(dialog: ChoiceDialog<T>) {
  choiceDialog.value = dialog as unknown as ChoiceDialog
}

export interface TextDialog {
  title: string
  description?: string
  placeholder?: string
  multiline?: boolean
  /** Hide what's typed (passwords). */
  password?: boolean
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
