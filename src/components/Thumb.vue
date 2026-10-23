<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { IconName } from '../icons'
import { thumbnailAt } from '../ytm/thumbnails'
import MIcon from './MIcon.vue'

const props = withDefaults(
  defineProps<{
    src?: string
    /** Rendered size in CSS pixels; used to request a matching image size. */
    size?: number
    shape?: 'rounded' | 'circle' | 'square'
    icon?: IconName
    eager?: boolean
  }>(),
  { src: undefined, size: 64, shape: 'rounded', icon: 'music', eager: false },
)

const failed = ref(false)
const loaded = ref(false)

watch(
  () => props.src,
  () => {
    failed.value = false
    loaded.value = false
  },
)

const url = computed(() => {
  const density = Math.min(window.devicePixelRatio || 1, 3)
  return thumbnailAt(props.src, props.size * density)
})
</script>

<template>
  <span class="thumb" :class="`thumb-${shape}`">
    <span v-if="!url || failed || !loaded" class="thumb-fallback" aria-hidden="true">
      <MIcon :name="icon" :size="Math.max(18, Math.round(size * 0.36))" />
    </span>
    <img
      v-if="url && !failed"
      :src="url"
      alt=""
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      draggable="false"
      referrerpolicy="no-referrer"
      :class="{ 'is-loaded': loaded }"
      @load="loaded = true"
      @error="failed = true"
    />
  </span>
</template>
