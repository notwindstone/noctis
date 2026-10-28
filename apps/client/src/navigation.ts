import { computed, nextTick, reactive, ref } from 'vue'
import { registerBackTarget } from './back'
import { App as NativeApp } from '@capacitor/app'
import { isNative, type BackEventData } from './native'
import type { BrowseTarget, Item } from './models'
import { animationsOff } from './preferences'

export type TabId = 'home' | 'library' | 'settings'

export type CollectionId = 'liked' | 'downloads' | 'cached' | 'history' | 'local'
/** Settings section id: built-in ('account', 'appearance', …) or added by a plugin. */
export type SettingsPage = string

export type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'settings' }
  | { name: 'search'; query?: string }
  | { name: 'album'; id: string; source?: string }
  | { name: 'playlist'; id: string; source?: string }
  | { name: 'artist'; id: string; source?: string }
  | { name: 'browse'; target: BrowseTarget; title?: string }
  | { name: 'collection'; id: CollectionId }
  | { name: 'library-playlists' }
  | { name: 'library-artists' }
  | { name: 'settings-page'; page: SettingsPage }
  | { name: 'downloads-queue' }

export interface Entry {
  key: number
  route: Route
}

export const TABS: TabId[] = ['home', 'library', 'settings']

let nextKey = 1
const entry = (route: Route): Entry => ({ key: nextKey++, route })

export const tab = ref<TabId>('home')
export const stacks = reactive<Record<TabId, Entry[]>>({
  home: [entry({ name: 'home' })],
  library: [entry({ name: 'library' })],
  settings: [entry({ name: 'settings' })],
})

export const currentStack = computed(() => stacks[tab.value])
export const currentEntry = computed(() => currentStack.value[currentStack.value.length - 1])

/**
 * The visual side of navigation lives in ScreenStack.vue, which registers itself here.
 * Navigation decides *what* changes; the animator decides *how it looks*.
 */
export interface StackAnimator {
  push(from: number, to: number): Promise<void>
  pop(from: number, to: number): Promise<void>
  switchTab(from: number, to: number): Promise<void>
  gestureStart(from: number, to: number, event: BackEventData): void
  gestureProgress(event: BackEventData): void
  gestureCancel(): Promise<void>
  gestureCommit(): Promise<void>
  /** Drop held animation frames once the DOM reflects the new state. */
  settle(): void
  /** Jump every running transition to its last frame (a newer navigation is waiting). */
  finishNow(): void
}

let animator: StackAnimator | null = null

/*
 * Navigation never waits for an animation to finish. Every operation goes through
 * run(): a new tap fast-forwards whatever is animating to its last frame and queues
 * behind it, and operations that already have another one waiting behind them skip
 * their animation entirely. Rapid taps therefore land immediately and in order.
 */
let chain: Promise<void> = Promise.resolve()
let pending = 0
let gestureActive = false

function run(operation: (animate: boolean) => Promise<void>): Promise<void> {
  pending++
  animator?.finishNow()
  const next = chain.then(async () => {
    try {
      // With animations off there's nothing to play: the 1 ms animation it would get still flashes the screen underneath.
      await operation(pending === 1 && !animationsOff())
    } finally {
      pending--
    }
  })
  chain = next.catch(() => {})
  return next
}

/** End a transition: hide the outgoing screen first, then release the animations. */
async function finishTransition() {
  transitionKeys.value = []
  await nextTick()
  animator?.settle()
}

export function setAnimator(value: StackAnimator | null) {
  animator = value
}

/** Keys that must stay visible while a transition runs (besides the current top). */
export const transitionKeys = ref<number[]>([])

const MAX_DEPTH = 24

const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

export function navigate(route: Route) {
  if (gestureActive) return Promise.resolve()
  return run(async (animate) => {
    const stack = stacks[tab.value]
    const from = stack[stack.length - 1]
    // A double tap shouldn't open the same screen twice.
    if (sameRoute(from.route, route)) return

    const next = entry(route)
    stack.push(next)
    if (stack.length > MAX_DEPTH) stack.splice(1, 1)

    if (!animate || !animator) return
    transitionKeys.value = [from.key, next.key]
    try {
      await animator.push(from.key, next.key)
    } finally {
      await finishTransition()
    }
  })
}

export function openItem(item: Item) {
  switch (item.type) {
    case 'album':
      return navigate({ name: 'album', id: item.id, source: item.source })
    case 'artist':
      return navigate({ name: 'artist', id: item.id, source: item.source })
    case 'playlist':
      return navigate({ name: 'playlist', id: item.id, source: item.source })
    default:
      return undefined
  }
}

/** Open a "more" link: a playlist, album or artist id, or a generic browse page. */
export function openBrowse(target: BrowseTarget, title?: string) {
  const id = target.browseId
  if (id.startsWith('VL')) return navigate({ name: 'playlist', id: id.slice(2) })
  if (id.startsWith('MPRE')) return navigate({ name: 'album', id })
  if (id.startsWith('UC')) return navigate({ name: 'artist', id })
  return navigate({ name: 'browse', target, title })
}

/** The entry that back would reveal: the previous screen, or Home when at another tab's root. */
function backDestination(): { key: number; switchesTab: boolean } | null {
  const stack = stacks[tab.value]
  if (stack.length > 1) return { key: stack[stack.length - 2].key, switchesTab: false }
  if (tab.value !== 'home') {
    const home = stacks.home
    return { key: home[home.length - 1].key, switchesTab: true }
  }
  return null
}

function commitBack(switchesTab: boolean) {
  if (switchesTab) tab.value = 'home'
  else stacks[tab.value].pop()
}

export function goBack() {
  if (gestureActive) return Promise.resolve()
  return run(async (animate) => {
    const destination = backDestination()
    if (!destination) {
      if (isNative) void NativeApp.minimizeApp().catch(() => NativeApp.exitApp())
      return
    }

    const from = currentEntry.value.key
    if (!animate || !animator) {
      commitBack(destination.switchesTab)
      return
    }
    transitionKeys.value = [from, destination.key]
    try {
      await animator.pop(from, destination.key)
      commitBack(destination.switchesTab)
    } finally {
      await finishTransition()
    }
  })
}

export function selectTab(next: TabId) {
  if (gestureActive) return Promise.resolve()
  return run(async (animate) => {
    if (next === tab.value) {
      // Re-selecting the current tab returns to its root.
      const stack = stacks[next]
      if (stack.length > 1) stack.splice(1)
      return
    }

    const from = currentEntry.value.key
    const to = stacks[next][stacks[next].length - 1].key
    if (!animate || !animator) {
      tab.value = next
      return
    }
    transitionKeys.value = [from, to]
    tab.value = next
    try {
      await animator.switchTab(from, to)
    } finally {
      await finishTransition()
    }
  })
}

let gesture: { switchesTab: boolean } | null = null

/**
 * A gesture that begins while a transition is still running waits for the stack to
 * settle (the transition is fast-forwarded) and then picks up from the finger's latest
 * position, instead of being dropped for the rest of the swipe.
 */
let deferredGesture: { latest: BackEventData } | null = null

function startGesture(event: BackEventData) {
  const destination = backDestination()
  if (!destination || !animator) {
    gestureActive = false
    return
  }
  gesture = { switchesTab: destination.switchesTab }
  transitionKeys.value = [currentEntry.value.key, destination.key]
  animator.gestureStart(currentEntry.value.key, destination.key, event)
}

export function setupNavigation() {
  registerBackTarget({
    priority: 0,
    enabled: () => stacks[tab.value].length > 1 || tab.value !== 'home',
    onStart(event) {
      if (!animator || !backDestination()) return
      gestureActive = true
      if (pending === 0) {
        startGesture(event)
        return
      }

      deferredGesture = { latest: event }
      animator.finishNow()
      void chain.then(() => {
        const waiting = deferredGesture
        deferredGesture = null
        // Still swiping (not released or cancelled meanwhile): begin from where the finger is now.
        if (waiting && gestureActive && !gesture) startGesture(waiting.latest)
      })
    },
    onProgress(event) {
      if (gesture) animator?.gestureProgress(event)
      else if (deferredGesture) deferredGesture.latest = event
    },
    onCancel() {
      if (deferredGesture) {
        deferredGesture = null
        gestureActive = false
        return
      }
      if (!gesture) return
      gesture = null
      gestureActive = false
      void run(async () => {
        try {
          await animator?.gestureCancel()
        } finally {
          await finishTransition()
        }
      })
    },
    onInvoke() {
      if (deferredGesture) {
        // Released before the gesture could start: an ordinary back, queued.
        deferredGesture = null
        gestureActive = false
        void goBack()
        return
      }
      if (!gesture) {
        gestureActive = false
        void goBack()
        return
      }
      const { switchesTab } = gesture
      gesture = null
      gestureActive = false
      // Queued like any navigation, so a tap during the release animation isn't lost.
      void run(async () => {
        try {
          await animator?.gestureCommit()
          commitBack(switchesTab)
        } finally {
          await finishTransition()
        }
      })
    },
  })
}
