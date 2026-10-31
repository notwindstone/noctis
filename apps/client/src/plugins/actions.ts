import { shallowReactive } from 'vue'
import type { IconName } from '../icons'
import { writeLog } from './log'

/**
 * Actions decouple what a button shows from what it does. UI renders entries from an
 * action collection (icon, label, action id) and runs `executeAction(id, props)`; the
 * behaviour lives in this registry, so a plugin can add buttons (push an entry, register
 * an action) or change what an existing one does (register over its id).
 */

/** UI feedback for an action in progress, Kaede-style. */
export interface ActionHandlers {
  /** Long-running work started (the button shows a spinner where supported). */
  pending: () => void
  /** Done; an optional message is shown as a snackbar. */
  success: (message?: string) => void
  /** Failed; the message is shown as a snackbar. */
  error: (message: string, cause?: unknown) => void
  /** Back to idle without a result (e.g. a confirmation was cancelled). */
  reset: () => void
}

/** Returning `false` means "did not happen" (reported as a failure). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionFunction<Props = any> = (props: Props & { handlers: ActionHandlers }) => void | false | Promise<void | false>

export const Actions = shallowReactive<Record<string, ActionFunction>>({})

const owners = new Map<string, string>()

export function registerAction<Props>(id: string, action: ActionFunction<Props>, owner = 'unknown') {
  const previous = owners.get(id)
  if (previous !== undefined && previous !== owner) {
    writeLog(owner, 'warn', `Replacing action "${id}" (previously provided by ${previous})`)
  }
  owners.set(id, owner)
  Actions[id] = action as ActionFunction
}

export function unregisterAction(id: string) {
  delete Actions[id]
  owners.delete(id)
}

const noHandlers: ActionHandlers = { pending() {}, success() {}, error() {}, reset() {} }

/** Run an action. Resolves to false if it's missing, returned false, or threw. */
export async function executeAction(id: string, props: object, handlers: ActionHandlers = noHandlers): Promise<boolean> {
  const action = Actions[id]
  if (!action) {
    writeLog('noctis', 'warn', `No action registered as "${id}"`)
    return false
  }
  try {
    return (await action({ ...props, handlers })) !== false
  } catch (error) {
    writeLog(owners.get(id) ?? 'noctis', 'error', `Action "${id}" threw:`, error)
    handlers.error('Something went wrong', error)
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Action collections
 * ------------------------------------------------------------------ */

type Dynamic<Context, T> = T | ((context: Context) => T)

export interface ActionEntry<Context = unknown> {
  /** Unique within its collection; also keys the button's pending/success state. */
  id: string
  /** A Material Symbols name known to the app, or one added with `registerIcon`. */
  icon: Dynamic<Context, IconName | string>
  label: Dynamic<Context, string>
  /** The action to execute (see `registerAction`). */
  action: string
  /** Draw the icon filled (e.g. a liked heart). */
  filled?: (context: Context) => boolean
  /**
   * Menus draw a divider where the group changes between neighbouring entries. Built-in
   * song menu groups: 'play', 'library', 'go', 'share'; entries without one (most plugins')
   * end up in a section of their own after them.
   */
  group?: string
  visible?: (context: Context) => boolean
  disabled?: (context: Context) => boolean
  /** 0..1 shows a progress ring instead of the icon (e.g. a download in progress). */
  progress?: (context: Context) => number | undefined
}

export function resolveEntry<Context>(entry: ActionEntry<Context>, context: Context) {
  return {
    icon: typeof entry.icon === 'function' ? entry.icon(context) : entry.icon,
    label: typeof entry.label === 'function' ? entry.label(context) : entry.label,
    filled: entry.filled?.(context) ?? false,
    disabled: entry.disabled?.(context) ?? false,
    progress: entry.progress?.(context),
  }
}

/** Entries whose `visible` passes for this context. */
export function visibleEntries<Context>(entries: ActionEntry<Context>[], context: Context) {
  return entries.filter((entry) => entry.visible?.(context) ?? true)
}

/**
 * Every collection is its own reactive array, so `push`/`splice` from a plugin shows up
 * immediately. Built-in entries are added by src/plugins/builtins.ts.
 */
export const ActionCollections = shallowReactive({
  /** Song menu (long press / ⋮). Context: { item: Song, list?, queueIndex? } */
  songMenu: shallowReactive<ActionEntry[]>([]),
  /** Album menu. Context: { item: Album } */
  albumMenu: shallowReactive<ActionEntry[]>([]),
  /** Playlist and mix menu. Context: { item: Playlist } */
  playlistMenu: shallowReactive<ActionEntry[]>([]),
  /** Artist menu. Context: { item: Artist } */
  artistMenu: shallowReactive<ActionEntry[]>([]),
  /** Chips under the full player's controls. Context: { song: Song } */
  playerActions: shallowReactive<ActionEntry[]>([]),
}) as Record<string, ActionEntry[]> & {
  songMenu: ActionEntry[]
  albumMenu: ActionEntry[]
  playlistMenu: ActionEntry[]
  artistMenu: ActionEntry[]
  playerActions: ActionEntry[]
}

/** Create a new collection (a plugin's own buttons, rendered by its own component). */
export function defineCollection(name: string): ActionEntry[] {
  ActionCollections[name] ??= shallowReactive<ActionEntry[]>([])
  return ActionCollections[name]
}
