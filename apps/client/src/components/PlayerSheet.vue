<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBackTarget } from '../back'
import { haptic, tap, thresholdTracker } from '../haptics'
import { isLiked, toggleLike } from '../library'
import { navigate } from '../navigation'
import {
  currentHue,
  currentSong,
  cycleRepeat,
  duration,
  isLoading,
  isPlaying,
  next,
  position,
  previous,
  progress,
  queueTitle,
  seek,
  chapters,
  currentChapter,
  stopPlayback,
  toggleShuffle,
  togglePlay,
} from '../player'
import { playerArtworkColors, repeatMode, shuffleEnabled } from '../preferences'
import { colorSource, schemeStyle } from '../theme'
import { closePlayer, openPlayer, playerExpanded, playerExpansion, queueOpen, showItemMenu } from '../ui'
import { ActionCollections, executeAction, resolveEntry, visibleEntries, type ActionEntry } from '../plugins/actions'
import { showChapters } from '../plugins/builtins'
import { notify } from '../snackbar'
import { artistNames, STATION_SECONDS, type Song } from '../models'
import { isStationSong } from '../stations'

const sheet = ref<HTMLElement | null>(null)
const frameEl = ref<HTMLElement | null>(null)

/* ------------------------------------------------------------------ *
 * Expansion spring
 * ------------------------------------------------------------------ */

let frame = 0
let velocity = 0

function springTo(target: number, initialVelocity = 0) {
  cancelAnimationFrame(frame)
  velocity = initialVelocity
  let last = performance.now()
  const stiffness = 420
  const damping = 2 * Math.sqrt(stiffness)

  const step = (now: number) => {
    const dt = Math.min(0.032, (now - last) / 1000)
    last = now
    const x = playerExpansion.value
    const acceleration = -stiffness * (x - target) - damping * velocity
    velocity += acceleration * dt
    const nextX = x + velocity * dt
    if (Math.abs(nextX - target) < 0.0015 && Math.abs(velocity) < 0.02) {
      playerExpansion.value = target
      return
    }
    playerExpansion.value = Math.min(1, Math.max(0, nextX))
    frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
}

watch(playerExpanded, (expanded) => {
  springTo(expanded ? 1 : 0, velocity)
  if (!expanded) queueOpen.value = false
})

onBeforeUnmount(() => cancelAnimationFrame(frame))

watch(currentSong, (song) => {
  if (!song) {
    playerExpanded.value = false
    playerExpansion.value = 0
  }
})

/* ------------------------------------------------------------------ *
 * Drag: vertical to expand/collapse, horizontal on the mini player to skip
 * ------------------------------------------------------------------ */

interface Drag {
  id: number
  x: number
  y: number
  startExpansion: number
  axis: 'none' | 'y' | 'x' | 'down'
  travel: number
  samples: { t: number; y: number }[]
  fromMini: boolean
}

let drag: Drag | null = null
const skipOffset = ref(0)
/** Clicks as a drag crosses the point where letting go would act. */
const threshold = thresholdTracker()
/** Pixels the collapsed mini player has been pulled down (swipe down to stop). */
const dropOffset = ref(0)
const dropping = ref(false)

function travelDistance(): number {
  const height = sheet.value?.clientHeight ?? window.innerHeight
  return Math.max(200, height - viewport.value.nav - 72)
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement
  if (event.button !== 0 || target.closest('button, input, .no-drag, .queue-panel')) return
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startExpansion: playerExpansion.value,
    axis: 'none',
    travel: travelDistance(),
    samples: [{ t: event.timeStamp, y: event.clientY }],
    fromMini: playerExpansion.value < 0.5,
  }
}

function onPointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y

  if (drag.axis === 'none') {
    if (Math.hypot(dx, dy) < 8) return
    const vertical = Math.abs(dy) >= Math.abs(dx)
    if (!vertical && !drag.fromMini) {
      // Sideways drags on the full player belong to its content, not the sheet.
      drag = null
      return
    }
    // Pulling the mini player down (rather than up) dismisses it.
    drag.axis = !vertical ? 'x' : drag.fromMini && drag.startExpansion < 0.01 && dy > 0 ? 'down' : 'y'
    threshold.reset()
    cancelAnimationFrame(frame)
    // The root ignores pointer events (so the page stays usable), so capture on the frame.
    frameEl.value?.setPointerCapture(event.pointerId)
  }

  if (drag.axis === 'down') {
    dropOffset.value = Math.max(0, dy)
    threshold.update(dropOffset.value > 44)
    drag.samples.push({ t: event.timeStamp, y: event.clientY })
    if (drag.samples.length > 6) drag.samples.shift()
  } else if (drag.axis === 'y') {
    playerExpansion.value = Math.min(1, Math.max(0, drag.startExpansion - dy / drag.travel))
    threshold.update(drag.startExpansion < 0.5 ? playerExpansion.value > 0.5 : playerExpansion.value < 0.5)
    drag.samples.push({ t: event.timeStamp, y: event.clientY })
    if (drag.samples.length > 6) drag.samples.shift()
  } else {
    skipOffset.value = dx
    threshold.update(Math.abs(dx) > (sheet.value?.clientWidth ?? window.innerWidth) * 0.28)
  }
}

function onPointerUp(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  const current = drag
  drag = null

  if (current.axis === 'none') {
    if (current.fromMini) openFull()
    return
  }

  if (current.axis === 'down') {
    const first = current.samples[0]
    const last = current.samples[current.samples.length - 1]
    const speed = (last.y - first.y) / Math.max(1, last.t - first.t)
    dropping.value = true
    if (dropOffset.value > 44 || speed > 0.5) {
      haptic('gestureEnd')
      dropOffset.value = 160
      window.setTimeout(() => {
        stopPlayback()
        dropOffset.value = 0
        dropping.value = false
      }, 220)
    } else {
      dropOffset.value = 0
      window.setTimeout(() => (dropping.value = false), 220)
    }
    return
  }

  if (current.axis === 'x') {
    const width = sheet.value?.clientWidth ?? window.innerWidth
    if (Math.abs(skipOffset.value) > width * 0.28) {
      haptic('gestureEnd')
      if (skipOffset.value < 0) next()
      else previous()
    }
    skipOffset.value = 0
    return
  }

  const first = current.samples[0]
  const last = current.samples[current.samples.length - 1]
  const dt = Math.max(1, last.t - first.t)
  const pxPerMs = (last.y - first.y) / dt
  // Expansion units per second (positive = expanding).
  const expansionVelocity = (-pxPerMs * 1000) / current.travel

  let expand: boolean
  if (Math.abs(pxPerMs) > 0.35) expand = pxPerMs < 0
  else expand = playerExpansion.value > 0.5

  velocity = expansionVelocity
  if (expand === playerExpanded.value) springTo(expand ? 1 : 0, expansionVelocity)
  else playerExpanded.value = expand
}

function openFull() {
  tap()
  openPlayer()
}

/* ------------------------------------------------------------------ *
 * Predictive back pulls the player down
 * ------------------------------------------------------------------ */

/** 0..1 while a back gesture is pulling on the expanded player. */
const backPull = ref(0)

useBackTarget({
  priority: 10,
  enabled: () => playerExpanded.value,
  onStart() {
    cancelAnimationFrame(frame)
  },
  onProgress(event) {
    const p = 1 - (1 - event.progress) ** 2
    backPull.value = p
    playerExpansion.value = 1 - 0.12 * p
  },
  onCancel() {
    backPull.value = 0
    springTo(1)
  },
  onInvoke() {
    backPull.value = 0
    velocity = 0
    closePlayer()
  },
})

useBackTarget({
  priority: 15,
  enabled: () => playerExpanded.value && queueOpen.value,
  onInvoke() {
    queueOpen.value = false
  },
})

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/*
 * The morph between mini player and full screen is a FLIP-style container transform:
 * the frame is scaled to the current rectangle and the content inside it is scaled
 * back by the inverse, so only `transform` changes per frame and everything stays on
 * the compositor. (Animating clip-path and top/left/right meant layout and a
 * full-screen repaint every frame, which stuttered on phones.)
 */

const MINI_HEIGHT = 64
const MINI_GAP = 8
const MINI_SIDE = 10
const MINI_RADIUS = 20

/** The desktop layout (main.css, same breakpoint): a navigation rail instead of a bottom bar. */
const WIDE_QUERY = '(min-width: 840px)'
const MINI_MAX_WIDTH = 680
const MINI_BOTTOM_WIDE = 16

/** Viewport, the bottom bar's height and the rail's width, measured rather than derived from CSS. */
const viewport = ref({ width: window.innerWidth, height: window.innerHeight, nav: 80, rail: 0 })

function measure() {
  const root = sheet.value
  const wide = window.matchMedia(WIDE_QUERY).matches
  const bar = document.querySelector('.bottom-nav')?.getBoundingClientRect()
  viewport.value = {
    width: root?.clientWidth || window.innerWidth,
    height: root?.clientHeight || window.innerHeight,
    nav: wide ? 0 : (bar?.height ?? 80),
    rail: wide ? (bar?.width ?? 88) : 0,
  }
}

/**
 * Where the mini player rests: its left edge, width and distance from the bottom. On a
 * phone it floats above the bar; on a desktop it's centred in the content next to the rail.
 */
const miniBox = computed(() => {
  const { width: W, nav, rail } = viewport.value
  if (rail === 0) return { left: MINI_SIDE, width: W - 2 * MINI_SIDE, bottom: nav + MINI_GAP }
  const width = Math.min(MINI_MAX_WIDTH, W - rail - 32)
  return { left: rail + (W - rail - width) / 2, width, bottom: MINI_BOTTOM_WIDE }
})

let resizeObserver: ResizeObserver | null = null
onMounted(() => window.addEventListener('resize', measure))
watch(sheet, (root) => {
  resizeObserver?.disconnect()
  if (!root) return
  measure()
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(root)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  resizeObserver?.disconnect()
})

const e = computed(() => playerExpansion.value)

/** The sheet's on-screen rectangle for the current expansion (and back-gesture pull). */
const rect = computed(() => {
  const { width: W, height: H } = viewport.value
  const inv = 1 - e.value
  const pull = backPull.value
  const mini = miniBox.value
  const miniTop = H - mini.bottom - MINI_HEIGHT

  // Both edges move from the mini player's to the window's; a back gesture pulls them in.
  const x = mini.left * inv + 14 * pull
  const right = W - (W - (mini.left + mini.width)) * inv - 14 * pull
  const y = miniTop * inv
  const width = Math.max(1, right - x)
  const height = Math.max(1, H - inv * (H - MINI_HEIGHT))
  return {
    x,
    y,
    sx: width / W,
    sy: height / H,
    radius: MINI_RADIUS * inv + 32 * pull,
  }
})

const sheetStyle = computed(() => {
  const style: Record<string, string> = {}
  if (dropOffset.value > 0) {
    style.transform = `translate3d(0, ${dropOffset.value}px, 0)`
    style.opacity = String(Math.max(0, 1 - dropOffset.value / 140))
  }
  if (playerArtworkColors.value && currentHue.value !== null && colorSource.value !== 'artwork') {
    Object.assign(style, schemeStyle(currentHue.value))
  }
  return style
})

const frameStyle = computed(() => {
  const { x, y, sx, sy } = rect.value
  return { transform: `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})` }
})

/**
 * Inverse scale, plus an offset that keeps the content horizontally fixed on screen
 * while the frame narrows (so it's trimmed evenly on both sides). Vertically the
 * content rides with the frame's top edge.
 */
const contentStyle = computed(() => {
  const { x, sx, sy } = rect.value
  return { transform: `scale(${1 / sx}, ${1 / sy}) translate3d(${-x}px, 0, 0)` }
})

/**
 * The backdrop is scaled with the frame, so its corner radius is pre-divided by the
 * scale to come out round. Only this plain gradient repaints; the content doesn't.
 */
const backdropStyle = computed(() => {
  const { sx, sy, radius } = rect.value
  return { borderRadius: radius > 0.01 ? `${radius / sx}px / ${radius / sy}px` : '0' }
})

const tintStyle = computed(() => ({ opacity: String(e.value) }))

/**
 * Snap to whole device pixels. A composited layer (the mini player has will-change: transform)
 * drawn at a fractional offset is resampled, which softens its text and artwork; on a Windows
 * display scaled to 125% or 150% every whole CSS pixel offset is fractional in device pixels.
 */
const snap = (value: number) => {
  const density = window.devicePixelRatio || 1
  return Math.round(value * density) / density
}

const miniStyle = computed(() => ({
  // As wide as the frame it grows into, so dragging it up doesn't leave it narrower than the sheet.
  width: `${snap(viewport.value.width * rect.value.sx)}px`,
  opacity: String(Math.max(0, 1 - e.value * 3)),
  pointerEvents: e.value > 0.3 ? ('none' as const) : undefined,
  visibility: e.value > 0.4 ? ('hidden' as const) : undefined,
  transform: `translate3d(${snap(rect.value.x + skipOffset.value * 0.6)}px, ${snap(rect.value.y)}px, 0)`,
}))

const fullStyle = computed(() => ({
  opacity: String(Math.min(1, Math.max(0, (e.value - 0.2) / 0.6))),
  pointerEvents: e.value < 0.6 ? ('none' as const) : undefined,
  visibility: e.value < 0.01 ? ('hidden' as const) : undefined,
}))

/** A station has no real length: no bar, no times. */
const isStationNow = computed(() => (currentSong.value ? isStationSong(currentSong.value) : false) || duration.value >= STATION_SECONDS)

const liked = computed(() => (currentSong.value ? isLiked(currentSong.value.id) : false))
/* Chips under the controls come from the playerActions collection (src/plugins/actions.ts). */
const chipStatus = ref<Record<string, 'pending' | 'success' | undefined>>({})

const chips = computed(() => {
  const song = currentSong.value
  if (!song) return []
  const context = { song }
  return visibleEntries(ActionCollections.playerActions as ActionEntry<typeof context>[], context).map((entry) => ({
    entry,
    ...resolveEntry(entry, context),
  }))
})

function runChip(entry: ActionEntry<{ song: Song }>) {
  const song = currentSong.value
  if (!song) return
  tap()
  const id = entry.id
  const set = (state: 'pending' | 'success' | undefined) => (chipStatus.value = { ...chipStatus.value, [id]: state })
  void executeAction(entry.action, { song }, {
    pending: () => set('pending'),
    success: (message) => {
      if (message) notify(message)
      set('success')
      window.setTimeout(() => set(undefined), 1000)
    },
    error: (message) => {
      notify(message)
      set(undefined)
    },
    reset: () => set(undefined),
  }).then(() => {
    // An action that never reported back shouldn't leave its chip spinning.
    if (chipStatus.value[id] === 'pending') set(undefined)
  })
}

async function onToggle() {
  haptic('press')
  await togglePlay()
}

function onNext() {
  tap()
  next()
}

function onPrevious() {
  tap()
  previous()
}

function onLike() {
  if (!currentSong.value) return
  haptic(liked.value ? 'toggleOff' : 'toggleOn')
  void toggleLike(currentSong.value)
}


function onShuffle() {
  haptic(shuffleEnabled.value ? 'toggleOff' : 'toggleOn')
  toggleShuffle()
}

function onRepeat() {
  haptic('tick')
  cycleRepeat()
}

function onCollapse() {
  tap()
  closePlayer()
}


function openArtist() {
  const artist = currentSong.value?.artists.find((item) => item.id)
  if (!artist?.id) return
  closePlayer()
  void navigate({ name: 'artist', id: artist.id })
}

function openMenu() {
  if (!currentSong.value) return
  tap()
  showItemMenu({ item: currentSong.value })
}
</script>

<template>
  <div
    v-if="currentSong"
    ref="sheet"
    class="player-sheet"
    :class="{ 'is-expanded': playerExpanded, 'is-dropping': dropping }"
    :style="sheetStyle"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div ref="frameEl" class="player-frame" :style="frameStyle">
      <div class="player-backdrop" :style="backdropStyle" aria-hidden="true">
        <div class="player-backdrop-tint" :style="tintStyle" />
      </div>
      <div class="player-content" :style="contentStyle">
        <!-- Full player -->
        <div class="full-player" :style="fullStyle" :aria-hidden="e < 0.6">
          <header class="full-player-bar">
            <button class="icon-button" type="button" aria-label="Collapse player" @click="onCollapse">
              <C.MIcon name="collapse" />
            </button>
            <div class="full-player-source">
              <span class="type-label-small">Playing from</span>
              <strong class="type-label-large">{{ queueTitle || 'Your queue' }}</strong>
            </div>
            <button class="icon-button" type="button" aria-label="More options" @click="openMenu">
              <C.MIcon name="more" />
            </button>
          </header>

          <div class="full-player-art">
            <C.PlayerArt :song="currentSong" />
          </div>

          <div class="full-player-meta">
            <div class="full-player-titles">
              <h2 class="type-headline-small">{{ currentSong.title }}</h2>
              <button class="full-player-artist type-body-large" type="button" @click="openArtist">
                {{ artistNames(currentSong.artists) }}
              </button>
              <button v-if="currentChapter && chapters.length > 1" class="full-player-chapter type-label-large" type="button" @click="showChapters">
                {{ currentChapter.title }}
              </button>
            </div>
            <button
              class="icon-button large"
              :class="{ 'is-active': liked }"
              type="button"
              :aria-pressed="liked"
              :aria-label="liked ? 'Remove from liked songs' : 'Like'"
              @click="onLike"
            >
              <C.MIcon name="favorite" :filled="liked" />
            </button>
          </div>

          <C.SeekBar v-if="!isStationNow" :position="position" :duration="duration" :marks="chapters.map((chapter) => chapter.start)" @seek="seek" />

          <div class="full-player-controls">
            <button
              class="icon-button large"
              :class="{ 'is-active': shuffleEnabled }"
              type="button"
              :aria-pressed="shuffleEnabled"
              aria-label="Shuffle"
              @click="onShuffle"
            >
              <C.MIcon name="shuffle" />
            </button>
            <button class="control-button" type="button" aria-label="Previous" @click="onPrevious">
              <C.MIcon name="previous" filled :size="30" />
            </button>
            <button
              class="play-button"
              :class="{ 'is-playing': isPlaying }"
              type="button"
              :aria-label="isPlaying ? 'Pause' : 'Play'"
              @click="onToggle"
            >
              <span v-if="isLoading" class="spinner large" aria-hidden="true" />
              <C.MIcon :name="isPlaying ? 'pause' : 'play'" filled :size="36" />
            </button>
            <button class="control-button" type="button" aria-label="Next" @click="onNext">
              <C.MIcon name="next" filled :size="30" />
            </button>
            <button
              class="icon-button large"
              :class="{ 'is-active': repeatMode !== 'off' }"
              type="button"
              :aria-label="`Repeat: ${repeatMode}`"
              @click="onRepeat"
            >
              <C.MIcon :name="repeatMode === 'one' ? 'repeat-one' : 'repeat'" />
            </button>
          </div>

          <div class="full-player-actions">
            <button
              v-for="chip in chips"
              :key="chip.entry.id"
              class="chip-button"
              :class="{ 'is-active': chip.filled }"
              type="button"
              :disabled="chip.disabled || chipStatus[chip.entry.id] === 'pending'"
              @click="runChip(chip.entry)"
            >
              <span v-if="chipStatus[chip.entry.id] === 'pending'" class="chip-spinner" aria-hidden="true" />
              <svg v-else-if="chip.progress !== undefined" class="progress-ring" viewBox="0 0 20 20" :style="{ '--p': chip.progress }" aria-hidden="true">
                <circle class="progress-ring-track" cx="10" cy="10" r="8" />
                <circle class="progress-ring-arc" cx="10" cy="10" r="8" />
              </svg>
              <C.MIcon v-else :name="chipStatus[chip.entry.id] === 'success' ? 'check' : chip.icon" :size="20" />
              {{ chip.label }}
            </button>
          </div>

          <Transition name="queue-panel">
            <C.QueuePanel v-if="queueOpen" @close="queueOpen = false" />
          </Transition>
        </div>
      </div>
    </div>

    <!-- Mini player -->
    <div class="mini-player" :style="miniStyle" :aria-hidden="e > 0.3">
      <div class="mini-player-main" role="button" tabindex="0" aria-label="Open player" @keydown.enter="openFull">
        <C.Thumb class="mini-player-art" :src="currentSong.thumbnail" :size="48" eager />
        <span class="mini-player-text">
          <strong>{{ currentSong.title }}</strong>
          <span>{{ artistNames(currentSong.artists) }}</span>
        </span>
      </div>
      <button class="icon-button" type="button" aria-label="Previous" @click="onPrevious">
        <C.MIcon name="previous" filled />
      </button>
      <button class="mini-play" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" @click="onToggle">
        <span v-if="isLoading" class="spinner" aria-hidden="true" />
        <C.MIcon :name="isPlaying ? 'pause' : 'play'" filled />
      </button>
      <button class="icon-button" type="button" aria-label="Next" @click="onNext">
        <C.MIcon name="next" filled />
      </button>
      <span class="mini-progress" :style="{ transform: `scaleX(${progress})` }" aria-hidden="true" />
    </div>
  </div>
</template>
