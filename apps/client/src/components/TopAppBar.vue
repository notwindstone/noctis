<script setup lang="ts">
import { C } from '../plugins/components'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { goBack } from '../navigation'

const props = withDefaults(
  defineProps<{
    title?: string
    back?: boolean
    /** Title only fades in after scrolling past this many pixels (for pages with a big header). */
    revealAt?: number
    /** Transparent over a hero image until scrolled. */
    overlay?: boolean
  }>(),
  { title: '', back: false, revealAt: 0, overlay: false },
)

const bar = ref<HTMLElement | null>(null)
const scrolled = ref(false)
const titleVisible = ref(props.revealAt === 0)

let scroller: HTMLElement | null = null

function onScroll() {
  if (!scroller) return
  const top = scroller.scrollTop
  scrolled.value = top > 4
  titleVisible.value = props.revealAt === 0 || top > props.revealAt
}

onMounted(() => {
  scroller = bar.value?.closest('.screen-layer') ?? null
  scroller?.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})

onBeforeUnmount(() => scroller?.removeEventListener('scroll', onScroll))
</script>

<template>
  <header
    ref="bar"
    class="top-bar"
    :class="{ 'is-scrolled': scrolled, 'is-overlay': overlay && !scrolled }"
  >
    <button v-if="back" class="icon-button" type="button" aria-label="Back" @click="goBack">
      <C.MIcon name="back" />
    </button>
    <h1 class="top-bar-title" :class="{ 'is-visible': titleVisible, 'has-back': back }">
      <slot name="title">{{ title }}</slot>
    </h1>
    <div class="top-bar-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
