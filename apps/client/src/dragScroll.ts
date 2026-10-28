/**
 * Horizontal lists (chip rows, carousels) scroll under a pressed finger on a phone; with a
 * mouse there's only the wheel. This lets a held mouse button drag them the same way, for
 * every horizontally scrolling element, plugin-made ones included.
 */
const THRESHOLD = 5
/** Controls that use horizontal drags themselves. */
const OWN_DRAG = 'input, textarea, select, [role="slider"], [contenteditable="true"], .seek, .mini-player'

function scroller(from: Element | null): HTMLElement | null {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth + 1) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow === 'auto' || overflow === 'scroll') return el
  }
  return null
}

export function initDragScroll() {
  let target: HTMLElement | null = null
  let startX = 0
  let startScroll = 0
  let dragging = false
  let snap = ''
  let behavior = ''
  /** The latest pointer position, applied once per frame instead of on every (faster) event. */
  let latestX = 0
  let frame = 0
  let momentum = 0
  /** Pixels per millisecond, smoothed over the last moves. */
  let velocity = 0
  let lastX = 0
  let lastTime = 0

  const apply = () => {
    frame = 0
    if (target && dragging) target.scrollLeft = startScroll - (latestX - startX)
  }

  /** Let go with some speed: keep gliding, slowing down, like a touch scroll does. */
  function glide(list: HTMLElement, restore: () => void) {
    let speed = velocity * 16
    let previous = performance.now()
    const step = (now: number) => {
      const frames = Math.min(4, (now - previous) / 16)
      previous = now
      const before = list.scrollLeft
      list.scrollLeft -= speed * frames
      speed *= Math.pow(0.95, frames)
      if (Math.abs(speed) < 0.4 || list.scrollLeft === before) return restore()
      momentum = requestAnimationFrame(step)
    }
    momentum = requestAnimationFrame(step)
  }

  const end = () => {
    if (!target) return
    const list = target
    target = null
    if (!dragging) return
    dragging = false
    cancelAnimationFrame(frame)
    frame = 0
    document.documentElement.classList.remove('is-drag-scrolling')
    const restore = () => {
      list.style.scrollSnapType = snap
      list.style.scrollBehavior = behavior
    }
    // The release would count as a click on whatever is under the pointer.
    const swallow = (event: Event) => event.stopPropagation()
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    if (Math.abs(velocity) > 0.3 && performance.now() - lastTime < 80) glide(list, restore)
    else restore()
  }

  window.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    cancelAnimationFrame(momentum)
    const element = event.target as Element | null
    if (element?.closest(OWN_DRAG)) return
    target = scroller(element)
    if (!target) return
    startX = lastX = latestX = event.clientX
    startScroll = target.scrollLeft
    lastTime = performance.now()
    velocity = 0
    dragging = false
  })

  window.addEventListener('pointermove', (event) => {
    if (!target) return
    if (event.buttons !== 1) return end()
    latestX = event.clientX
    if (!dragging) {
      if (Math.abs(latestX - startX) < THRESHOLD) return
      dragging = true
      // Snapping would pull the list back to a card edge on every step, and smooth scrolling
      // would make each assignment chase the last one.
      snap = target.style.scrollSnapType
      behavior = target.style.scrollBehavior
      target.style.scrollSnapType = 'none'
      target.style.scrollBehavior = 'auto'
      document.documentElement.classList.add('is-drag-scrolling')
    }
    const now = performance.now()
    if (now > lastTime) {
      velocity = velocity * 0.6 + ((event.clientX - lastX) / (now - lastTime)) * 0.4
      lastX = event.clientX
      lastTime = now
    }
    if (!frame) frame = requestAnimationFrame(apply)
  })

  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  // Images and links start a native drag-and-drop that would take over the gesture.
  window.addEventListener('dragstart', (event) => {
    if (target) event.preventDefault()
  })
}
