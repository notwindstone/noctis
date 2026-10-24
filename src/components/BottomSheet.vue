<script setup lang="ts">
import { ref, watch } from 'vue'
import { useBackTarget } from '../back'
import { useSheetDrag } from '../sheetDrag'

/** M3 modal bottom sheet: drag down to dismiss (src/sheetDrag.ts), predictive back shrinks it. */
const props = defineProps<{ open: boolean; label?: string }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const backProgress = ref(0)

// Closing animates from wherever the finger left the sheet (the leave transition starts there).
const { offset, dragging, onTouchStart, onTouchEnd, onPointerDown } = useSheetDrag(panel, {
  onClose: () => emit('close'),
  scrollSelector: '.sheet-scroll',
})

watch(
  () => props.open,
  (open) => {
    if (open) {
      offset.value = 0
      backProgress.value = 0
    }
  },
)

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
          :class="{ 'is-dragging': dragging }"
          :style="{
            transform:
              offset > 0 || backProgress > 0
                ? `translate3d(0, ${offset + backProgress * 24}px, 0) scale(${1 - backProgress * 0.06})`
                : undefined,
          }"
          @touchstart.passive="onTouchStart"
          @touchend="onTouchEnd"
          @touchcancel="onTouchEnd"
          @pointerdown="onPointerDown"
        >
          <span class="sheet-handle" aria-hidden="true" />
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
