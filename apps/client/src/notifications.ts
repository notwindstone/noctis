import { App as NativeApp } from '@capacitor/app'
import {
  isPermissionGranted,
  requestPermission as requestDesktopPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { hasNoctisPlugin, isDesktop, Noctis } from './native'

/**
 * System notifications for the app and its plugins: Android's notification shade, the
 * browser's Notifications API (a desktop backend can slot in beside them). Progress
 * notifications are first-class: `progress` is a real bar on Android and a percentage
 * in the text where the platform has no bar.
 *
 * A notification is identified by its `id`; `show` with an id that's showing updates it.
 */
export interface NotificationOptions {
  id: string
  title: string
  body?: string
  /** 0..1 draws a progress bar; "indeterminate" a busy one. */
  progress?: number | 'indeterminate'
  /** Can't be swiped away: for work that's still going. */
  ongoing?: boolean
  /** No sound or pop-up (progress, background chores). */
  quiet?: boolean
  /** Buttons (Android). The browser can't show them; `onAction('click')` still works. */
  actions?: { id: string; label: string }[]
  /** Only while the app is in the background: in the foreground the app shows it itself. */
  onlyInBackground?: boolean
  /** The notification was tapped (`'click'`) or one of its buttons (the action's id). */
  onAction?: (action: string) => void
}

export type NotificationPermission = 'granted' | 'denied' | 'prompt'

interface Backend {
  permission(): Promise<NotificationPermission>
  requestPermission(): Promise<NotificationPermission>
  show(options: NotificationOptions): Promise<void>
  close(id: string): Promise<void>
}

const normalize = (state: string): NotificationPermission => (state === 'granted' || state === 'denied' ? state : 'prompt')

const androidBackend: Backend = {
  async permission() {
    return normalize((await Noctis.checkNotificationPermission()).state)
  },
  async requestPermission() {
    return normalize((await Noctis.requestNotificationPermission()).state)
  },
  async show({ id, title, body, progress, ongoing, quiet, actions }) {
    await Noctis.showNotification({
      id,
      title,
      body,
      progress: typeof progress === 'number' ? progress : undefined,
      indeterminate: progress === 'indeterminate',
      ongoing,
      quiet,
      actions,
    })
  },
  async close(id) {
    await Noctis.closeNotification({ id })
  },
}

const webNotifications = new Map<string, Notification>()

const webBackend: Backend = {
  async permission() {
    if (typeof Notification === 'undefined') return 'denied'
    return Notification.permission === 'default' ? 'prompt' : Notification.permission
  },
  async requestPermission() {
    if (typeof Notification === 'undefined') return 'denied'
    return normalize(await Notification.requestPermission())
  },
  async show({ id, title, body, progress, quiet }) {
    // No progress bars on the web: put the figure in the text.
    const text = [body, typeof progress === 'number' ? `${Math.round(progress * 100)}%` : undefined].filter(Boolean).join(' • ')
    const notification = new Notification(title, { body: text || undefined, tag: id, silent: quiet })
    notification.onclick = () => {
      window.focus()
      handlers.get(id)?.('click')
      notification.close()
    }
    webNotifications.set(id, notification)
  },
  async close(id) {
    webNotifications.get(id)?.close()
    webNotifications.delete(id)
  },
}

/** Desktop notifications can't be updated in place, so a progress one is shown once and again when it finishes. */
const desktopShown = new Map<string, number>()

const desktopBackend: Backend = {
  async permission() {
    return (await isPermissionGranted()) ? 'granted' : 'prompt'
  },
  async requestPermission() {
    return normalize(await requestDesktopPermission())
  },
  async show({ id, title, body, progress, quiet }) {
    const last = desktopShown.get(id)
    const finished = typeof progress === 'number' && progress >= 1
    if (last !== undefined && !finished && typeof progress === 'number') return
    desktopShown.set(id, typeof progress === 'number' ? progress : 1)
    sendNotification({ title, body, silent: quiet })
  },
  async close(id) {
    desktopShown.delete(id)
  },
}

const backend: Backend = hasNoctisPlugin ? androidBackend : isDesktop ? desktopBackend : webBackend

const handlers = new Map<string, (action: string) => void>()
/** What the caller last asked for; what's on screen is derived from it and the app's visibility. */
const wanted = new Map<string, NotificationOptions>()
const onScreen = new Set<string>()
const lastRender = new Map<string, number>()
const timers = new Map<string, number>()

/** Progress updates come per chunk; the system only needs a few a second. */
const MIN_INTERVAL = 800

let background = typeof document !== 'undefined' && document.hidden

function render(id: string) {
  window.clearTimeout(timers.get(id))
  timers.delete(id)
  const options = wanted.get(id)
  const visible = options !== undefined && (!options.onlyInBackground || background)

  if (!visible) {
    if (onScreen.delete(id)) void backend.close(id).catch(() => {})
    return
  }
  const wait = MIN_INTERVAL - (Date.now() - (lastRender.get(id) ?? 0))
  if (wait > 0 && onScreen.has(id)) {
    timers.set(id, window.setTimeout(() => render(id), wait))
    return
  }
  lastRender.set(id, Date.now())
  onScreen.add(id)
  void backend.show(options).catch(() => onScreen.delete(id))
}

function setBackground(value: boolean) {
  if (background === value) return
  background = value
  for (const id of wanted.keys()) render(id)
}

document.addEventListener('visibilitychange', () => setBackground(document.hidden))
if (hasNoctisPlugin) {
  void NativeApp.addListener('appStateChange', ({ isActive }) => setBackground(!isActive))
  void Noctis.addListener('notificationAction', ({ id, action }) => handlers.get(id)?.(action))
}

export const permission = () => backend.permission()
export const requestPermission = () => backend.requestPermission()

/**
 * Show a notification, or update it if `id` is showing. Asks for permission the first
 * time (so call it from something the user did); resolves false if it wasn't allowed.
 */
export async function show(options: NotificationOptions): Promise<boolean> {
  let state = await backend.permission().catch((): NotificationPermission => 'denied')
  if (state === 'prompt') state = await backend.requestPermission().catch((): NotificationPermission => 'denied')
  if (state !== 'granted') return false

  wanted.set(options.id, options)
  if (options.onAction) handlers.set(options.id, options.onAction)
  else handlers.delete(options.id)
  render(options.id)
  return true
}

/** Change part of a showing notification. */
export function update(id: string, changes: Partial<Omit<NotificationOptions, 'id'>>) {
  const current = wanted.get(id)
  if (!current) return
  wanted.set(id, { ...current, ...changes })
  render(id)
}

export function close(id: string) {
  wanted.delete(id)
  handlers.delete(id)
  render(id)
}
