<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, ref, watch } from 'vue'
import type { IconName } from '../icons'
import { thumbnailAt } from '../thumbnails'

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
/** hq720 stills don't exist for every (older) video; fall back to mqdefault once. */
const downgraded = ref(false)

watch(
  () => props.src,
  () => {
    failed.value = false
    loaded.value = false
    downgraded.value = false
  },
)

const url = computed(() => {
  const density = Math.min(window.devicePixelRatio || 1, 3)
  const resolved = thumbnailAt(props.src, props.size * density)
  return downgraded.value ? resolved?.replace('/hq720.jpg', '/mqdefault.jpg') : resolved
})

function onError() {
  if (!downgraded.value && url.value?.includes('/hq720.jpg')) downgraded.value = true
  else failed.value = true
}
</script>

<template>
  <span class="thumb" :class="`thumb-${shape}`">
    <span v-if="!url || failed || !loaded" class="thumb-fallback" aria-hidden="true">
      <C.MIcon :name="icon" :size="Math.max(18, Math.round(size * 0.36))" />
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
      @error="onError"
    />
  </span>
</template>
