import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { thresholdTracker } from './haptics'

export interface SheetDragOptions {
  /** Called when the sheet is released past the threshold or flung. */
  onClose: () => void
  /** Scrollable area inside the sheet; dragging from it only starts at its top. */
  scrollSelector: string
  /** Elements whose touches must never drag the sheet (e.g. reorder handles). */
  ignoreSelector?: string
  /** Fraction of the sheet's height (or width, sliding sideways) past which releasing closes it. */
  closeAt?: number
  /**
   * Which way it's dragged to close, read each time a drag starts: "y" pulls a bottom
   * sheet down, "x" pushes a side panel to the right. Sideways drags only start on
   * `handleSelector`, since the panel's own content needs the pointer.
   */
  axis?: () => 'x' | 'y'
  handleSelector?: string
}

/**
 * Drag-to-dismiss for bottom sheets (and, with `axis`, side panels): the sheet follows the finger when pulled down from
 * its header, or from its list once that's scrolled to the top; released past
 * `closeAt` (or flung) it closes, otherwise it springs back.
 *
 * Touch input uses touch events rather than pointer events: the list must stay
 * natively scrollable, and with pointer events the browser takes the gesture over and
 * cancels it. Mouse input (browser build) uses pointer events.
 */
export function useSheetDrag(panel: Ref<HTMLElement | null>, options: SheetDragOptions) {
  const offset = ref(0)
  const dragging = ref(false)
  const threshold = thresholdTracker()
  const closeAt = options.closeAt ?? 0.3

  let tracking = false
  let sideways = false
  let startY = 0
  let height = 400
  let scroller: HTMLElement | null = null
  let samples: { t: number; y: number }[] = []

  /** The coordinate that matters: x for a panel dragged sideways, y otherwise. */
  const along = (point: { clientX: number; clientY: number }) => (sideways ? point.clientX : point.clientY)

  function begin(point: { clientX: number; clientY: number }, target: EventTarget | null, time: number) {
    const element = target as Element | null
    if (options.ignoreSelector && element?.closest(options.ignoreSelector)) return
    sideways = options.axis?.() === 'x'
    if (sideways && !element?.closest(options.handleSelector ?? '*')) return
    const y = along(point)
    tracking = true
    startY = y
    height = (sideways ? panel.value?.offsetWidth : panel.value?.offsetHeight) || 400
    scroller = sideways ? null : (element?.closest<HTMLElement>(options.scrollSelector) ?? null)
    samples = [{ t: time, y }]
    threshold.reset()
  }

  /** Returns true when the move belongs to the sheet (so the caller can stop scrolling). */
  function move(y: number, time: number): boolean {
    if (!tracking) return false
    const dy = y - startY

    if (!dragging.value) {
      if (dy < -6 || (scroller && scroller.scrollTop > 0)) {
        tracking = false
        return false
      }
      // Claim downward moves from the first pixel: the browser decides on the first
      // move whether a touch scrolls, and the list can't scroll up past its top anyway.
      if (dy <= 0) return false
      if (dy < 6) return true
      dragging.value = true
      startY = y
    }

    offset.value = Math.max(0, y - startY)
    samples.push({ t: time, y })
    if (samples.length > 5) samples.shift()
    threshold.update(offset.value > height * closeAt)
    return true
  }

  function end(cancelled: boolean) {
    tracking = false
    if (!dragging.value) return
    dragging.value = false

    const first = samples[0]
    const last = samples[samples.length - 1]
    const speed = (last.y - first.y) / Math.max(1, last.t - first.t)

    if (!cancelled && (offset.value > height * closeAt || speed > 0.6)) options.onClose()
    else offset.value = 0
  }

  function onTouchStart(event: TouchEvent) {
    if (event.touches.length === 1) begin(event.touches[0], event.target, event.timeStamp)
  }
  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0]
    if (touch && move(along(touch), event.timeStamp) && event.cancelable) event.preventDefault()
  }
  function onTouchEnd(event: TouchEvent) {
    end(event.type === 'touchcancel')
  }

  function onPointerMove(event: PointerEvent) {
    move(along(event), event.timeStamp)
  }
  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove)
    end(false)
  }
  function onPointerDown(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    begin(event, event.target, event.timeStamp)
    if (!tracking) return
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  // touchmove must be non-passive to cancel scrolling, so it's attached by hand.
  watch(panel, (element, previous) => {
    previous?.removeEventListener('touchmove', onTouchMove)
    element?.addEventListener('touchmove', onTouchMove, { passive: false })
  })

  onBeforeUnmount(() => {
    panel.value?.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('pointermove', onPointerMove)
  })

  return { offset, dragging, onTouchStart, onTouchEnd, onPointerDown }
}
