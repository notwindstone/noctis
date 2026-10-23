<script setup lang="ts">
import { ref } from 'vue'
import { useBackTarget } from '../back'
import { thresholdTracker } from '../haptics'

/** M3 modal bottom sheet: drag down or swipe back to dismiss. */
const props = defineProps<{ open: boolean; label?: string }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const offset = ref(0)
const backProgress = ref(0)
let startY = 0
let dragging = false
let lastY = 0
let lastT = 0
let speed = 0
const threshold = thresholdTracker()

function onDown(event: PointerEvent) {
  const scroller = (event.target as HTMLElement).closest('.sheet-scroll')
  if (scroller && scroller.scrollTop > 0) return
  dragging = true
  startY = event.clientY
  lastY = event.clientY
  lastT = event.timeStamp
  speed = 0
}

function onMove(event: PointerEvent) {
  if (!dragging) return
  const dy = event.clientY - startY
  if (dy > 6 && !panel.value?.hasPointerCapture(event.pointerId)) {
    panel.value?.setPointerCapture(event.pointerId)
  }
  offset.value = Math.max(0, dy)
  threshold.update(offset.value > (panel.value?.offsetHeight ?? 400) * 0.3)
  speed = (event.clientY - lastY) / Math.max(1, event.timeStamp - lastT)
  lastY = event.clientY
  lastT = event.timeStamp
}

function onUp() {
  if (!dragging) return
  dragging = false
  threshold.reset()
  const height = panel.value?.offsetHeight ?? 400
  if (offset.value > height * 0.3 || speed > 0.6) emit('close')
  offset.value = 0
}

useBackTarget({
  priority: 20,
  enabled: () => props.open,
  onProgress(event) {
    backProgress.value = event.progress
  },
  onCancel() {
    backProgress.value = 0
  },
  onInvoke() {
    backProgress.value = 0
    emit('close')
  },
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet-root">
        <div class="sheet-scrim" @click="emit('close')" />
        <div
          ref="panel"
          class="sheet-panel"
          role="dialog"
          aria-modal="true"
          :aria-label="label"
          :class="{ 'is-dragging': offset > 0 }"
          :style="{
            transform:
              offset > 0 || backProgress > 0
                ? `translate3d(0, ${offset + backProgress * 24}px, 0) scale(${1 - backProgress * 0.06})`
                : undefined,
          }"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <span class="sheet-handle" aria-hidden="true" />
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
