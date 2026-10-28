<script setup lang="ts">
import { C } from '../plugins/components'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatTime } from '../format'
import { haptic, tap } from '../haptics'
import { currentIndex, isPlaying, jumpTo, moveInQueue, queue, queueTitle, removeFromQueue } from '../player'
import { useSheetDrag } from '../sheetDrag'
import { artistNames } from '../models'

const emit = defineEmits<{ close: [] }>()

/**
 * Moves and removals are animated by hand (animateRows, removeRow). A TransitionGroup
 * would treat every drag frame as a reorder and fight the dragged row's position.
 */
const list = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
/** True for the frame a reorder lands, so the drag-shift transition doesn't fight the FLIP. */
const settling = ref(false)

// Drag the panel down to dismiss; touches on the reorder handles never move it.
/** The desktop layout puts the queue beside the player: it slides in from the right and is pushed back out. */
const WIDE = '(min-width: 900px) and (min-aspect-ratio: 6 / 5)'
const wideQuery = window.matchMedia(WIDE)
const sideways = () => wideQuery.matches
/** The close arrow points where the panel goes: right beside the player, down as a sheet. */
const isSideways = ref(wideQuery.matches)
const onWideChange = () => (isSideways.value = wideQuery.matches)
wideQuery.addEventListener('change', onWideChange)
onBeforeUnmount(() => wideQuery.removeEventListener('change', onWideChange))

const sheet = useSheetDrag(panelEl, {
  onClose: () => emit('close'),
  axis: () => (sideways() ? 'x' : 'y'),
  handleSelector: '.sheet-handle, .queue-grip',
  scrollSelector: '.queue-list',
  ignoreSelector: '.queue-handle',
})

const listEl = () => list.value

/** Where every row is on screen right now (including drag offsets), by song id. */
function rowPositions(): Map<string, number> {
  const tops = new Map<string, number>()
  for (const row of listEl()?.querySelectorAll<HTMLElement>('[data-song-id]') ?? []) {
    tops.set(row.dataset.songId!, row.getBoundingClientRect().top)
  }
  return tops
}

/** FLIP: glide each row from where it was on screen to its new slot (compositor-only). */
function animateRows(before: Map<string, number>) {
  for (const row of listEl()?.querySelectorAll<HTMLElement>('[data-song-id]') ?? []) {
    const from = before.get(row.dataset.songId!)
    if (from === undefined) continue
    const delta = from - row.getBoundingClientRect().top
    if (Math.abs(delta) < 0.5) continue
    row.animate([{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: 'none' }], {
      duration: 340,
      easing: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    })
  }
}

/** Slide the row out, then let the rows below glide up into its place. */
async function removeRow(index: number) {
  const row = listEl()?.querySelector<HTMLElement>(`[data-queue-index="${index}"]`)
  if (row) {
    await row
      .animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translate3d(24%, 0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)', fill: 'forwards' },
      )
      .finished.catch(() => {})
  }
  const before = rowPositions()
  removeFromQueue(index)
  await nextTick()
  animateRows(before)
}
const dragIndex = ref<number | null>(null)
const dragOffset = ref(0)
let dragStartY = 0
let rowHeight = 64
let lastTarget = 0

/** Clicking outside the side panel closes it, like the player's own sheets (not the chip that toggles it). */
function onOutsidePointerDown(event: PointerEvent) {
  if (!sideways() || sheet.dragging.value) return
  const target = event.target as Element | null
  if (!target || panelEl.value?.contains(target) || target.closest('.full-player-actions, .dialog-root, .sheet-root')) return
  emit('close')
}

onMounted(() => document.addEventListener('pointerdown', onOutsidePointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointerDown, true))

onMounted(async () => {
  await nextTick()
  const current = list.value?.querySelector<HTMLElement>('.queue-row.is-current')
  current?.scrollIntoView({ block: 'center' })
})

/*
 * All row interaction is delegated to the list: one click handler (play / remove) and
 * one set of pointer handlers for drag-to-reorder, instead of six listeners per row.
 */
function rowOf(event: Event): { row: HTMLElement; index: number } | null {
  const row = (event.target as Element | null)?.closest<HTMLElement>('[data-queue-index]')
  if (!row) return null
  return { row, index: Number(row.dataset.queueIndex) }
}

function onListClick(event: MouseEvent) {
  const hit = rowOf(event)
  const action = (event.target as Element).closest<HTMLElement>('[data-action]')?.dataset.action
  if (!hit || !action) return
  if (action === 'play') play(hit.index)
  else if (action === 'remove') void removeRow(hit.index)
}

function onListPointerDown(event: PointerEvent) {
  const handle = (event.target as Element).closest<HTMLElement>('.queue-handle')
  const hit = handle ? rowOf(event) : null
  if (!handle || !hit) return
  onHandleDown(event, handle, hit.row, hit.index)
}

function onHandleDown(event: PointerEvent, handle: HTMLElement, row: HTMLElement, index: number) {
  rowHeight = row.offsetHeight || 64
  dragIndex.value = index
  dragStartY = event.clientY
  dragOffset.value = 0
  // Captured moves still bubble from the handle to the list's handlers.
  handle.setPointerCapture(event.pointerId)
  lastTarget = index
  haptic('dragStart')
}

function onHandleMove(event: PointerEvent) {
  if (dragIndex.value === null) return
  dragOffset.value = event.clientY - dragStartY
  // A tick for every slot the row moves past, like reordering lists in Android.
  const target = Math.min(queue.value.length - 1, Math.max(0, dragIndex.value + Math.round(dragOffset.value / rowHeight)))
  if (target !== lastTarget) {
    lastTarget = target
    haptic('tick')
  }
}

async function onHandleUp() {
  if (dragIndex.value === null) return
  const from = dragIndex.value
  const to = Math.min(queue.value.length - 1, Math.max(0, from + Math.round(dragOffset.value / rowHeight)))
  haptic('gestureEnd')

  // Measure while rows still show their drag offsets, so the dropped row glides from
  // under the finger and the others from where they had shifted to.
  const before = rowPositions()
  settling.value = true
  dragIndex.value = null
  dragOffset.value = 0
  moveInQueue(from, to)
  await nextTick()
  animateRows(before)
  requestAnimationFrame(() => (settling.value = false))
}

/** Rows between the dragged row and its target shift to make room. */
function rowShift(index: number): number {
  if (dragIndex.value === null) return 0
  if (index === dragIndex.value) return dragOffset.value
  const target = dragIndex.value + Math.round(dragOffset.value / rowHeight)
  if (dragIndex.value < index && index <= target) return -rowHeight
  if (target <= index && index < dragIndex.value) return rowHeight
  return 0
}

function play(index: number) {
  tap()
  jumpTo(index)
}
</script>

<template>
  <section
    ref="panelEl"
    class="queue-panel"
    :class="{ 'is-dragging': sheet.dragging.value }"
    :style="{ transform: sheet.offset.value > 0 ? (sideways() ? `translate3d(${sheet.offset.value}px, 0, 0)` : `translate3d(0, ${sheet.offset.value}px, 0)`) : undefined }"
    aria-label="Up next"
    @touchstart.passive="sheet.onTouchStart"
    @touchend="sheet.onTouchEnd"
    @touchcancel="sheet.onTouchEnd"
    @pointerdown="sheet.onPointerDown"
  >
    <span class="queue-grip" aria-hidden="true" />
    <header class="queue-header">
      <span class="sheet-handle" aria-hidden="true" />
      <div class="queue-title">
        <h3 class="type-title-large">Up next</h3>
        <span class="type-body-medium muted">{{ queueTitle || 'Queue' }} · {{ queue.length }} songs</span>
      </div>
      <button class="icon-button" type="button" aria-label="Close queue" @click="emit('close')">
        <C.MIcon :name="isSideways ? 'chevron-right' : 'collapse'" />
      </button>
    </header>

    <ol
      ref="list"
      class="queue-list"
      :class="{ 'is-settling': settling }"
      @click="onListClick"
      @pointerdown="onListPointerDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
    >
      <li
        v-for="(song, index) in queue"
        :key="song.id"
        class="queue-row"
        :data-queue-index="index"
        :data-song-id="song.id"
        :class="{ 'is-current': index === currentIndex, 'is-dragging': index === dragIndex, 'is-played': index < currentIndex }"
        :style="{ transform: rowShift(index) ? `translate3d(0, ${rowShift(index)}px, 0)` : undefined }"
      >
        <button class="queue-row-main" type="button" data-action="play">
          <span class="item-row-art">
            <C.Thumb :src="song.thumbnail" :size="44" />
            <span v-if="index === currentIndex" class="item-row-playing" aria-hidden="true">
              <span v-if="isPlaying" class="eq"><span /><span /><span /></span>
              <C.MIcon v-else name="pause" filled :size="18" />
            </span>
          </span>
          <span class="item-row-text">
            <span class="item-row-title type-body-large">{{ song.title }}</span>
            <span class="item-row-subtitle type-body-medium">
              <span>{{ artistNames(song.artists) }}<template v-if="song.duration"> · {{ formatTime(song.duration) }}</template></span>
            </span>
          </span>
        </button>
        <button
          v-if="index !== currentIndex"
          class="icon-button"
          type="button"
          :aria-label="`Remove ${song.title} from queue`"
          data-action="remove"
        >
          <C.MIcon name="close" :size="20" />
        </button>
        <span class="queue-handle" aria-hidden="true">
          <C.MIcon name="drag" />
        </span>
      </li>
    </ol>
  </section>
</template>
