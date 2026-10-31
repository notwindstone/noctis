<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatTime } from '../format'
import { haptic } from '../haptics'

const props = defineProps<{ position: number; duration: number; disabled?: boolean; /** Seconds where a chapter starts: drawn as small gaps in the bar. */ marks?: number[]; /** Seconds loaded so far, drawn as a grey stretch ahead of the position. */ buffered?: number }>()
const emit = defineEmits<{ seek: [seconds: number] }>()

const track = ref<HTMLElement | null>(null)
const dragging = ref(false)
const preview = ref(0)

const shown = computed(() => (dragging.value ? preview.value : props.position))
const percent = computed(() => (props.duration > 0 ? Math.min(100, Math.max(0, (shown.value / props.duration) * 100)) : 0))

/** Where the loaded stretch ends, never before the position. */
const bufferedPercent = computed(() => (props.duration > 0 ? Math.min(100, Math.max(percent.value, ((props.buffered ?? 0) / props.duration) * 100)) : 0))

function ratioAt(clientX: number): number {
  const rect = track.value?.getBoundingClientRect()
  if (!rect || rect.width === 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

function onDown(event: PointerEvent) {
  if (props.disabled || props.duration <= 0) return
  dragging.value = true
  haptic('tick')
  preview.value = ratioAt(event.clientX) * props.duration
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onMove(event: PointerEvent) {
  if (!dragging.value) return
  preview.value = ratioAt(event.clientX) * props.duration
}

function onUp() {
  if (!dragging.value) return
  dragging.value = false
  haptic('gestureEnd')
  emit('seek', preview.value)
}

function onKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0
  if (step) {
    event.preventDefault()
    emit('seek', Math.min(props.duration, Math.max(0, props.position + step)))
  }
}
</script>

<template>
  <div class="seek no-drag">
    <div
      ref="track"
      class="seek-track"
      :class="{ 'is-dragging': dragging }"
      role="slider"
      tabindex="0"
      aria-label="Seek"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(shown)"
      :aria-valuetext="formatTime(shown)"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey"
    >
      <span class="seek-active" :style="{ width: `max(0px, calc(${percent}% - 6px))` }" />
      <span class="seek-inactive" :style="{ left: `min(100%, calc(${percent}% + 6px))` }" />
      <span
        v-show="bufferedPercent > percent"
        class="seek-buffered"
        :class="{ 'is-complete': bufferedPercent >= 99.5 }"
        :style="{ left: `min(100%, calc(${percent}% + 6px))`, width: `max(0px, calc(${bufferedPercent - percent}% - 6px))` }"
      />
      <span
        v-for="mark in marks ?? []"
        v-show="mark > 0 && duration > 0 && mark < duration"
        :key="mark"
        class="seek-mark"
        :style="{ left: `${(mark / duration) * 100}%` }"
      />
      <span class="seek-handle" :style="{ left: `${percent}%` }" />
    </div>
    <div class="seek-times type-label-medium">
      <span>{{ formatTime(shown) }}</span>
      <span>{{ formatTime(duration) }}</span>
    </div>
  </div>
</template>
