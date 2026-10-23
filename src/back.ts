import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { hasNoctisPlugin, Noctis, type BackEventData } from './native'

/**
 * One place for every "back": Android's predictive back gesture (with progress, via
 * the Noctis plugin), the browser's back button and Escape. Things that can be
 * dismissed register a target; the highest-priority enabled one receives the gesture.
 *
 * Priorities: screens 0, player 10, menus/dialogs 20.
 */
export interface BackTarget {
  priority: number
  enabled: () => boolean
  /** Gesture started (Android 14+). */
  onStart?: (event: BackEventData) => void
  /** Gesture moved; event.progress is 0..1. */
  onProgress?: (event: BackEventData) => void
  /** Gesture abandoned. */
  onCancel?: () => void
  /** Back committed (gesture released, button pressed, browser back, Escape). */
  onInvoke: () => void
}

const targets = shallowRef<{ target: BackTarget; order: number }[]>([])
let order = 0

const activeTarget = computed<BackTarget | null>(() => {
  let best: { target: BackTarget; order: number } | null = null
  for (const entry of targets.value) {
    if (!entry.target.enabled()) continue
    if (
      !best ||
      entry.target.priority > best.target.priority ||
      (entry.target.priority === best.target.priority && entry.order > best.order)
    ) {
      best = entry
    }
  }
  return best?.target ?? null
})

export const canHandleBack = computed(() => activeTarget.value !== null)

export function registerBackTarget(target: BackTarget): () => void {
  const entry = { target, order: order++ }
  targets.value = [...targets.value, entry]
  return () => {
    targets.value = targets.value.filter((item) => item !== entry)
  }
}

/** Register for the lifetime of the calling component. */
export function useBackTarget(target: BackTarget) {
  const unregister = registerBackTarget(target)
  onBeforeUnmount(unregister)
}

/** Programmatic back, e.g. an app bar arrow. */
export function invokeBack() {
  activeTarget.value?.onInvoke()
}

let gestureTarget: BackTarget | null = null

function setupNativeBack() {
  watch(canHandleBack, (enabled) => void Noctis.setBackEnabled({ enabled }).catch(() => {}), { immediate: true })

  void Noctis.addListener('backStarted', (event) => {
    gestureTarget = activeTarget.value
    gestureTarget?.onStart?.(event)
  })
  void Noctis.addListener('backProgressed', (event) => {
    gestureTarget?.onProgress?.(event)
  })
  void Noctis.addListener('backCancelled', () => {
    gestureTarget?.onCancel?.()
    gestureTarget = null
  })
  void Noctis.addListener('backInvoked', () => {
    const target = gestureTarget ?? activeTarget.value
    gestureTarget = null
    target?.onInvoke()
  })
}

/**
 * Browser fallback: keep one "guard" history entry while something can go back, so the
 * back button lands on us instead of leaving the page.
 */
function setupHistoryBack() {
  let guarded = false
  let ignorePop = false

  const pushGuard = () => {
    if (guarded) return
    window.history.pushState({ noctisGuard: true }, '')
    guarded = true
  }

  window.addEventListener('popstate', () => {
    guarded = false
    if (ignorePop) {
      ignorePop = false
      return
    }
    activeTarget.value?.onInvoke()
    // Let the state settle before deciding whether another guard is needed.
    queueMicrotask(() => {
      if (canHandleBack.value) pushGuard()
    })
  })

  watch(
    canHandleBack,
    (enabled) => {
      if (enabled) pushGuard()
      else if (guarded) {
        guarded = false
        ignorePop = true
        window.history.back()
      }
    },
    { immediate: true },
  )

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !canHandleBack.value) return
    const target = event.target as HTMLElement | null
    if (target?.tagName === 'INPUT' && (target as HTMLInputElement).value) return
    event.preventDefault()
    invokeBack()
  })
}

/**
 * Browser stand-in for the system gesture: dragging in from a screen edge produces the
 * same start/progress/cancel/invoke events, so predictive back can be developed and
 * tested without a device.
 */
function setupEdgeSwipe() {
  const EDGE = 24
  let swipe: { id: number; edge: 'left' | 'right'; startX: number; target: BackTarget; started: boolean } | null = null

  const eventAt = (event: PointerEvent): BackEventData => {
    const width = window.innerWidth
    const distance = swipe!.edge === 'left' ? event.clientX - swipe!.startX : swipe!.startX - event.clientX
    return {
      progress: Math.min(1, Math.max(0, distance / (width * 0.6))),
      touchX: event.clientX,
      touchY: event.clientY,
      swipeEdge: swipe!.edge,
    }
  }

  window.addEventListener(
    'pointerdown',
    (event) => {
      const target = activeTarget.value
      if (!target || event.button !== 0) return
      const edge = event.clientX <= EDGE ? 'left' : event.clientX >= window.innerWidth - EDGE ? 'right' : null
      if (!edge) return
      // Like the system gesture, an edge swipe belongs to back, not to whatever is underneath.
      event.stopPropagation()
      swipe = { id: event.pointerId, edge, startX: event.clientX, target, started: false }
    },
    { capture: true },
  )

  window.addEventListener(
    'pointermove',
    (event) => {
      if (!swipe || event.pointerId !== swipe.id) return
      event.stopPropagation()
      const data = eventAt(event)
      if (!swipe.started) {
        if (data.progress < 0.02) return
        swipe.started = true
        swipe.target.onStart?.(data)
      }
      event.preventDefault()
      swipe.target.onProgress?.(data)
    },
    { capture: true, passive: false },
  )

  const finish = (event: PointerEvent) => {
    if (!swipe || event.pointerId !== swipe.id) return
    const committed = event.type === 'pointerup' && eventAt(event).progress > 0.35
    const current = swipe
    swipe = null
    if (!current.started) return
    event.preventDefault()
    event.stopPropagation()
    if (committed) current.target.onInvoke()
    else current.target.onCancel?.()
  }

  window.addEventListener('pointerup', finish, { capture: true })
  window.addEventListener('pointercancel', finish, { capture: true })
}

let initialized = false

export function initBack() {
  if (initialized) return
  initialized = true
  if (hasNoctisPlugin) {
    setupNativeBack()
  } else {
    setupHistoryBack()
    setupEdgeSwipe()
  }
}
