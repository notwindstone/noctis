<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useBackTarget } from '../back'

const props = defineProps<{ open: boolean; title: string }>()
const emit = defineEmits<{ close: [] }>()

const backProgress = ref(0)

/*
 * A dialog taller than the window scrolls its body; dividers at the edges with more
 * content past them say so (a list cut off mid-row read as the end of it).
 */
const body = ref<HTMLElement | null>(null)
const more = ref({ above: false, below: false })
function measure() {
  const element = body.value
  if (!element) return
  more.value = { above: element.scrollTop > 1, below: element.scrollTop + element.clientHeight < element.scrollHeight - 1 }
}
let resized: ResizeObserver | null = null
let mutated: MutationObserver | null = null
watch(body, async (element) => {
  resized?.disconnect()
  mutated?.disconnect()
  if (!element) return
  await nextTick()
  measure()
  // The window changing size, or the content changing (a tab switched, a list loaded).
  resized = new ResizeObserver(measure)
  resized.observe(element)
  mutated = new MutationObserver(() => requestAnimationFrame(measure))
  mutated.observe(element, { childList: true, subtree: true })
})
onBeforeUnmount(() => {
  resized?.disconnect()
  mutated?.disconnect()
})

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
          <div ref="body" class="dialog-body" :class="{ 'has-more-above': more.above, 'has-more-below': more.below }" @scroll.passive="measure">
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
