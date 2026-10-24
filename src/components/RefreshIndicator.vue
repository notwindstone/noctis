<script setup lang="ts">
import { computed } from 'vue'
import { PULL_THRESHOLD } from '../pullToRefresh'

/** Material pull-to-refresh indicator: a disc that slides down from under the top bar. */
const props = defineProps<{ pull: number; dragging: boolean; refreshing: boolean }>()

const progress = computed(() => Math.min(1, props.pull / PULL_THRESHOLD))

const style = computed(() => ({
  transform: `translate3d(-50%, ${props.pull - 56}px, 0) scale(${0.6 + 0.4 * progress.value})`,
  opacity: String(props.pull > 0 || props.refreshing ? Math.min(1, progress.value * 1.6) : 0),
}))
</script>

<template>
  <div
    class="refresh-indicator"
    :class="{ 'is-dragging': dragging }"
    :style="style"
    role="progressbar"
    :aria-hidden="!refreshing"
    aria-label="Refreshing"
  >
    <span v-if="refreshing" class="loading-indicator small" />
    <span
      v-else
      class="refresh-arc"
      :style="{ '--p': progress * 0.8, transform: `rotate(${progress * 270}deg)` }"
    />
  </div>
</template>
