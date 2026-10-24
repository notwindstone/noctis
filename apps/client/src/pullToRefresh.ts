import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { haptic, thresholdTracker } from './haptics'

/** Pull distance (after resistance) at which releasing refreshes. */
export const PULL_THRESHOLD = 72
const MAX_PULL = 128
const SLOP = 8

/**
 * Pull-to-refresh for a screen. Listens on the screen's scroll layer; a downward drag
 * that starts at the very top of the page pulls the indicator in, and releasing past
 * the threshold runs `refresh`. Only the indicator moves (with transforms); the page
 * itself never shifts, so pulling doesn't reflow anything.
 */
export function usePullToRefresh(anchor: Ref<HTMLElement | null>, refresh: () => Promise<unknown>) {
  const pull = ref(0)
  const dragging = ref(false)
  const refreshing = ref(false)

  const threshold = thresholdTracker()
  let scroller: HTMLElement | null = null
  let tracking = false
  let startX = 0
  let startY = 0
  let suppressClick = false

  function begin(x: number, y: number) {
    if (refreshing.value || !scroller || scroller.scrollTop > 0) return
    tracking = true
    startX = x
    startY = y
  }

  /** Returns true when the move belongs to the pull (so the caller can cancel scrolling). */
  function move(x: number, y: number): boolean {
    if (!tracking || !scroller) return false
    const dy = y - startY
    const dx = x - startX

    if (!dragging.value) {
      // Sideways (a carousel) or upwards (scrolling): not a pull.
      const sideways = Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)
      if (sideways || dy < -SLOP || scroller.scrollTop > 0) {
        tracking = false
        return false
      }
      if (dy < SLOP) return false
      dragging.value = true
      threshold.reset()
    }

    // Resistance: the indicator follows the finger at about half speed, easing off further.
    const distance = Math.max(0, dy - SLOP)
    pull.value = Math.min(MAX_PULL, distance * 0.5 * (1 - Math.min(0.4, distance / 1200)))
    threshold.update(pull.value >= PULL_THRESHOLD)
    return true
  }

  async function end() {
    tracking = false
    if (!dragging.value) return
    dragging.value = false
    suppressClick = true
    window.setTimeout(() => (suppressClick = false), 0)

    if (pull.value < PULL_THRESHOLD) {
      pull.value = 0
      return
    }

    haptic('gestureEnd')
    refreshing.value = true
    pull.value = PULL_THRESHOLD
    try {
      await refresh()
    } finally {
      refreshing.value = false
      pull.value = 0
    }
  }

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) begin(event.touches[0].clientX, event.touches[0].clientY)
  }
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (touch && move(touch.clientX, touch.clientY) && event.cancelable) event.preventDefault()
  }
  const onTouchEnd = () => void end()

  // Mouse, for the browser build. Touch input goes through the touch events above.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button === 0) begin(event.clientX, event.clientY)
  }
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') move(event.clientX, event.clientY)
  }
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') void end()
  }
  // A pull that ends over a card shouldn't also open it.
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return
    event.stopPropagation()
    event.preventDefault()
  }

  onMounted(() => {
    scroller = anchor.value?.closest<HTMLElement>('.screen-layer') ?? null
    if (!scroller) return
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('touchend', onTouchEnd)
    scroller.addEventListener('touchcancel', onTouchEnd)
    scroller.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    scroller.addEventListener('click', onClick, true)
  })

  onBeforeUnmount(() => {
    if (scroller) {
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', onTouchEnd)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('click', onClick, true)
    }
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  })

  return { pull, dragging, refreshing }
}
