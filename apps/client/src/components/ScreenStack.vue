<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import type { BackEventData } from '../native'
import {
  currentEntry,
  setAnimator,
  stacks,
  tab,
  TABS,
  transitionKeys,
  type Entry,
  type StackAnimator,
} from '../navigation'
import { screenFor } from '../screens'
import { animationsOff } from '../preferences'
import { isNative } from '../native'
import { ACTIVE_KEY } from './screen-context'

/**
 * Renders every screen of every tab as its own layer, so screens keep their state and
 * scroll position, and the previous screen is already there to be revealed by a
 * predictive back gesture. Only the current screen (plus whatever a transition needs)
 * is visible.
 */

const root = ref<HTMLElement | null>(null)
const scrim = ref<HTMLElement | null>(null)

const layers = computed(() => TABS.flatMap((id) => stacks[id].map((entry, depth) => ({ entry, tab: id, depth }))))

/**
 * The screen a back gesture would reveal: the previous one in this tab, or Home's top
 * screen at another tab's root. It's kept rendered (behind the opaque current screen)
 * and on its own layer, so a gesture doesn't start by painting it from scratch.
 */
const underlayKey = computed<number | null>(() => {
  // Only the phone's back gesture reveals it. Elsewhere it would be a second screen painted under
  // every tab switch (and its layer made and dropped on each one) for nothing.
  if (!isNative) return null
  const stack = stacks[tab.value]
  if (stack.length > 1) return stack[stack.length - 2].key
  if (tab.value !== 'home') return stacks.home[stacks.home.length - 1].key
  return null
})

function isVisible(entry: Entry) {
  if (entry.key === currentEntry.value.key || transitionKeys.value.includes(entry.key)) return true
  // During other transitions (e.g. a tab fade) the underlay would show through.
  return entry.key === underlayKey.value && transitionKeys.value.length === 0
}

provide(ACTIVE_KEY, (key: number) => key === currentEntry.value.key && tab.value !== undefined)

function layer(key: number): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-screen-key="${key}"]`) ?? null
}

const reducedMotion = animationsOff

const EMPHASIZED_DECEL = 'cubic-bezier(0.05, 0.7, 0.1, 1)'
const EMPHASIZED_ACCEL = 'cubic-bezier(0.3, 0, 0.8, 0.15)'
const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)'

/**
 * Animations hold their final frame (fill: forwards) until navigation has hidden or
 * removed the outgoing screen; settle() then drops them. Cancelling earlier makes the
 * old screen flash back for a frame, which was the flicker.
 */
const held: Animation[] = []
const touched = new Set<HTMLElement>()

function animate(el: HTMLElement | null, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  if (!el) return Promise.resolve()
  touched.add(el)
  const duration = reducedMotion() ? 1 : (options.duration as number)
  const animation = el.animate(keyframes, { ...options, duration, fill: 'forwards' })
  held.push(animation)
  return animation.finished.then(
    () => {},
    () => {},
  )
}

function mark(el: HTMLElement | null) {
  if (el) touched.add(el)
}

function settle() {
  for (const animation of held.splice(0)) animation.cancel()
  for (const el of touched) {
    el.style.transform = ''
    el.style.opacity = ''
    el.style.borderRadius = ''
    el.style.zIndex = ''
    el.style.boxShadow = ''
    el.classList.remove('is-gesture-top', 'is-gesture-below')
  }
  touched.clear()
  if (scrim.value) {
    scrim.value.style.opacity = '0'
    scrim.value.style.zIndex = ''
  }
}

/* ------------------------------------------------------------------ *
 * Predictive back
 * ------------------------------------------------------------------ */

interface GestureState {
  top: HTMLElement | null
  below: HTMLElement | null
  /** Measured once at the start; reading layout per event would force a reflow. */
  width: number
  sign: number
  startY: number
  progress: number
  touchY: number
}

let gesture: GestureState | null = null
let gestureFrameId = 0

/** Progress events can outpace the display; apply only the latest, once per frame. */
function scheduleGestureFrame() {
  if (gestureFrameId) return
  gestureFrameId = requestAnimationFrame(() => {
    gestureFrameId = 0
    if (gesture) gestureFrame(gesture)
  })
}

/** Apply any pending frame now (before reading the current transform to animate from). */
function flushGestureFrame(state: GestureState) {
  if (!gestureFrameId) return
  cancelAnimationFrame(gestureFrameId)
  gestureFrameId = 0
  gestureFrame(state)
}

/** Map the raw progress through a decelerating curve, like the platform does. */
const eased = (p: number) => 1 - (1 - p) ** 2

function gestureFrame(state: GestureState) {
  const p = eased(state.progress)
  const width = state.width
  const dy = Math.max(-1, Math.min(1, (state.touchY - state.startY) / 300))

  const scale = 1 - 0.1 * p
  const x = state.sign * (width * 0.06) * p
  const y = dy * 28 * p
  const radius = 34 * Math.min(1, p * 4)

  if (state.top) {
    state.top.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
    state.top.style.borderRadius = `${radius}px`
  }
  if (state.below) {
    state.below.style.transform = `translate3d(${-state.sign * width * 0.04 * (1 - p)}px, 0, 0) scale(${0.94 + 0.06 * p})`
  }
  if (scrim.value) scrim.value.style.opacity = String(0.32 * (1 - p))
}

const animator: StackAnimator = {
  async push(from, to) {
    // The new screen is rendered by Vue on the next tick; animate only once it exists.
    await nextTick()
    const oldEl = layer(from)
    const newEl = layer(to)
    mark(newEl)
    if (newEl) newEl.style.zIndex = '2'
    await Promise.all([
      animate(newEl, [
        { transform: 'translate3d(22%, 0, 0)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 360, easing: EMPHASIZED_DECEL }),
      animate(oldEl, [
        { transform: 'none', opacity: 1 },
        { transform: 'translate3d(-10%, 0, 0)', opacity: 0 },
      ], { duration: 240, easing: EMPHASIZED_ACCEL }),
    ])
  },

  async pop(from, to) {
    await nextTick()
    const oldEl = layer(from)
    const newEl = layer(to)
    mark(oldEl)
    if (oldEl) oldEl.style.zIndex = '2'
    await Promise.all([
      animate(oldEl, [
        { transform: 'none', opacity: 1 },
        { transform: 'translate3d(22%, 0, 0)', opacity: 0 },
      ], { duration: 220, easing: EMPHASIZED_ACCEL }),
      animate(newEl, [
        { transform: 'translate3d(-10%, 0, 0)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 340, easing: EMPHASIZED_DECEL }),
    ])
  },

  async switchTab(from, to) {
    // Material fade-through.
    await nextTick()
    const oldEl = layer(from)
    const newEl = layer(to)
    await Promise.all([
      // The two overlap a little, so there's never a frame with neither on screen.
      animate(oldEl, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear' }),
      animate(newEl, [
        { opacity: 0, transform: 'scale(0.96)' },
        { opacity: 0, transform: 'scale(0.96)', offset: 0.15 },
        { opacity: 1, transform: 'none' },
      ], { duration: 240, easing: STANDARD }),
    ])
  },

  gestureStart(from, to, event: BackEventData) {
    const top = layer(from)
    const below = layer(to)
    mark(top)
    mark(below)
    if (top) {
      top.style.zIndex = '3'
      top.classList.add('is-gesture-top')
    }
    if (below) below.classList.add('is-gesture-below')
    if (scrim.value) scrim.value.style.zIndex = '2'

    gesture = {
      top,
      below,
      width: root.value?.clientWidth || window.innerWidth,
      sign: event.swipeEdge === 'right' ? -1 : 1,
      startY: event.touchY,
      touchY: event.touchY,
      progress: event.progress,
    }
    gestureFrame(gesture)
  },

  gestureProgress(event) {
    if (!gesture) return
    gesture.progress = event.progress
    gesture.touchY = event.touchY
    scheduleGestureFrame()
  },

  async gestureCancel() {
    const state = gesture
    gesture = null
    if (!state) return
    flushGestureFrame(state)
    await Promise.all([
      animate(state.top, [{ transform: state.top?.style.transform ?? 'none', borderRadius: state.top?.style.borderRadius ?? '0px' }, { transform: 'none', borderRadius: '0px' }], { duration: 220, easing: STANDARD }),
      animate(state.below, [{ transform: state.below?.style.transform ?? 'none' }, { transform: 'scale(0.94)' }], { duration: 220, easing: STANDARD }),
      animate(scrim.value, [{ opacity: scrim.value?.style.opacity ?? '0' }, { opacity: 0.32 }], { duration: 220, easing: STANDARD }),
    ])
  },

  settle,

  finishNow() {
    for (const animation of held) {
      if (animation.playState === 'running') animation.finish()
    }
  },

  async gestureCommit() {
    const state = gesture
    gesture = null
    if (!state) return
    flushGestureFrame(state)
    const width = state.width
    const fromTransform = state.top?.style.transform || 'none'
    await Promise.all([
      animate(state.top, [
        { transform: fromTransform, opacity: 1 },
        { transform: `translate3d(${state.sign * width * 0.5}px, 0, 0) scale(0.86)`, opacity: 0 },
      ], { duration: 240, easing: EMPHASIZED_ACCEL }),
      animate(state.below, [{ transform: state.below?.style.transform || 'none' }, { transform: 'none' }], { duration: 300, easing: EMPHASIZED_DECEL }),
      animate(scrim.value, [{ opacity: scrim.value?.style.opacity ?? '0' }, { opacity: 0 }], { duration: 200, easing: STANDARD }),
    ])
  },
}

onMounted(() => setAnimator(animator))
onBeforeUnmount(() => setAnimator(null))
</script>

<template>
  <div ref="root" class="screen-stack" :class="{ 'has-gestures': isNative }">
    <div
      v-for="layer in layers"
      :key="layer.entry.key"
      class="screen-layer"
      :class="{
        'is-hidden': !isVisible(layer.entry),
        'is-current': layer.entry.key === currentEntry.key,
        'is-underlay': layer.entry.key === underlayKey && layer.entry.key !== currentEntry.key,
      }"
      :data-screen-key="layer.entry.key"
      :aria-hidden="!isVisible(layer.entry)"
    >
      <component
        :is="screenFor(layer.entry.route)"
        :route="layer.entry.route"
        :screen-key="layer.entry.key"
        :is-root="layer.depth === 0"
      />
    </div>
    <div ref="scrim" class="screen-scrim" aria-hidden="true" />
  </div>
</template>
