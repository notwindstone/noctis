<script setup lang="ts">
import { ref } from 'vue'
import { useBackTarget } from '../back'

const props = defineProps<{ open: boolean; title: string }>()
const emit = defineEmits<{ close: [] }>()

const backProgress = ref(0)

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
    <Transition name="dialog">
      <div v-if="open" class="dialog-root">
        <div class="dialog-scrim" @click="emit('close')" />
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          :style="{ transform: backProgress > 0 ? `scale(${1 - backProgress * 0.08})` : undefined }"
        >
          <h2 class="type-headline-small dialog-title">{{ title }}</h2>
          <div class="dialog-body">
            <slot />
          </div>
          <div class="dialog-actions">
            <slot name="actions" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
