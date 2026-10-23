<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { formatTime } from '../format'
import { haptic, tap } from '../haptics'
import { currentIndex, isPlaying, jumpTo, moveInQueue, queue, queueTitle, removeFromQueue } from '../player'
import { artistNames } from '../ytm/models'
import MIcon from './MIcon.vue'
import Thumb from './Thumb.vue'

const emit = defineEmits<{ close: [] }>()

const list = ref<HTMLElement | null>(null)
const dragIndex = ref<number | null>(null)
const dragOffset = ref(0)
let dragStartY = 0
let rowHeight = 64
let lastTarget = 0

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
  else if (action === 'remove') removeFromQueue(hit.index)
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

function onHandleUp() {
  if (dragIndex.value === null) return
  const from = dragIndex.value
  const to = Math.min(queue.value.length - 1, Math.max(0, from + Math.round(dragOffset.value / rowHeight)))
  dragIndex.value = null
  dragOffset.value = 0
  haptic('gestureEnd')
  moveInQueue(from, to)
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
  <section class="queue-panel" aria-label="Up next">
    <header class="queue-header">
      <span class="sheet-handle" aria-hidden="true" />
      <div class="queue-title">
        <h3 class="type-title-large">Up next</h3>
        <span class="type-body-medium muted">{{ queueTitle || 'Queue' }} · {{ queue.length }} songs</span>
      </div>
      <button class="icon-button" type="button" aria-label="Close queue" @click="emit('close')">
        <MIcon name="collapse" />
      </button>
    </header>

    <ol
      ref="list"
      class="queue-list"
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
        :class="{ 'is-current': index === currentIndex, 'is-dragging': index === dragIndex, 'is-played': index < currentIndex }"
        :style="{ transform: rowShift(index) ? `translate3d(0, ${rowShift(index)}px, 0)` : undefined }"
      >
        <button class="queue-row-main" type="button" data-action="play">
          <span class="item-row-art">
            <Thumb :src="song.thumbnail" :size="44" />
            <span v-if="index === currentIndex" class="item-row-playing" aria-hidden="true">
              <span v-if="isPlaying" class="eq"><span /><span /><span /></span>
              <MIcon v-else name="pause" filled :size="18" />
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
          <MIcon name="close" :size="20" />
        </button>
        <span class="queue-handle" aria-hidden="true">
          <MIcon name="drag" />
        </span>
      </li>
    </ol>
  </section>
</template>
