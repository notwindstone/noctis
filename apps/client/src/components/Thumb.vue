<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { IconName } from '../icons'
import { networkTick } from '../network'
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

/** Which try this is: the picture is requested again (a new element) after a failure. */
const attempt = ref(0)
/** Pauses before trying again after a failure; then it waits for the network to come back. */
const RETRY_DELAYS = [2000, 6000, 15000, 40000]
/**
 * A request that never answers counts as failed. Only for eager images: a lazy one that's
 * off screen isn't requested at all, and mustn't be given up on for that.
 */
const LOAD_TIMEOUT = 20000
let retryTimer: ReturnType<typeof setTimeout> | undefined
let loadTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers() {
  clearTimeout(retryTimer)
  clearTimeout(loadTimer)
}

watch(
  () => props.src,
  () => {
    clearTimers()
    failed.value = false
    loaded.value = false
    downgraded.value = false
    attempt.value = 0
  },
)

function retry() {
  if (loaded.value || !url.value) return
  clearTimers()
  attempt.value++
  failed.value = false
  downgraded.value = false
}

function fail() {
  failed.value = true
  clearTimeout(loadTimer)
  clearTimeout(retryTimer)
  const delay = RETRY_DELAYS[attempt.value]
  if (delay !== undefined) retryTimer = setTimeout(retry, delay)
}

// A new request starts: give it a deadline.
watch(
  [() => props.src, attempt],
  () => {
    clearTimeout(loadTimer)
    if (props.src && props.eager) loadTimer = setTimeout(() => !loaded.value && fail(), LOAD_TIMEOUT)
  },
  { immediate: true },
)

// The network is back: try again at once.
watch(networkTick, () => {
  if (failed.value && !loaded.value) {
    attempt.value = 0
    retry()
  }
})

onBeforeUnmount(clearTimers)

const url = computed(() => {
  const density = Math.min(window.devicePixelRatio || 1, 3)
  const resolved = thumbnailAt(props.src, props.size * density)
  return downgraded.value ? resolved?.replace('/hq720.jpg', '/mqdefault.jpg') : resolved
})

function onError() {
  if (!downgraded.value && url.value?.includes('/hq720.jpg')) downgraded.value = true
  else fail()
}

function onLoad() {
  loaded.value = true
  clearTimers()
}
</script>

<template>
  <span class="thumb" :class="`thumb-${shape}`">
    <span v-if="!url || failed || !loaded" class="thumb-fallback" aria-hidden="true">
      <C.MIcon :name="icon" :size="Math.max(18, Math.round(size * 0.36))" />
    </span>
    <img
      v-if="url && !failed"
      :key="attempt"
      :src="url"
      alt=""
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      draggable="false"
      referrerpolicy="no-referrer"
      :class="{ 'is-loaded': loaded }"
      @load="onLoad"
      @error="onError"
    />
  </span>
</template>
