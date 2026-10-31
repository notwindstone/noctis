<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { analysisLive, useAnalysis, type AnalysisHandle } from '../analysis'
import { liveBars } from '../preferences'

/** The three bars of a playing song: they follow the music when allowed, else loop. */
let handle: AnalysisHandle | null = null
const levels = computed(() => handle?.levels.value ?? null)

watch(
  liveBars,
  (on) => {
    handle?.stop()
    handle = on ? useAnalysis({ bands: 3 }) : null
  },
  { immediate: true },
)
onBeforeUnmount(() => handle?.stop())

const following = computed(() => liveBars.value && analysisLive.value)

/** Quiet bands still show a stub; typical music sits between about 0.3 and 0.9 on the byte scale. */
function scale(band: number) {
  const level = levels.value?.[band] ?? 0
  return 0.15 + 0.85 * Math.min(1, Math.max(0, (level - 0.3) / 0.6))
}
</script>

<template>
  <span class="eq" :class="{ 'is-live': following }" aria-label="Playing">
    <span v-for="band in 3" :key="band" :style="following ? { transform: `scaleY(${scale(band - 1)})` } : undefined" />
  </span>
</template>
