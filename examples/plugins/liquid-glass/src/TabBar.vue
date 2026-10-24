<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Glass } from './glass'
import { Noctis } from './host'

/**
 * The iOS 26 tab bar: a floating glass capsule with the tabs, a glass circle for
 * search beside it, and the glass the mini player sits on.
 *
 * Keeps the `bottom-nav` class: the player measures it to place the mini player above.
 * Nothing here uses `transform` (it slides away with `bottom`): a transformed ancestor
 * would leave the glass nothing to refract.
 */

const { C } = Noctis
const { haptic } = Noctis.libs.haptics
const { navigate, selectTab, tab } = Noctis.libs.navigation
const { currentSong } = Noctis.libs.player
const { playerExpansion } = Noctis.libs.ui

const items = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const

const e = computed(() => playerExpansion.value)

const barStyle = computed(() => ({
  bottom: `${-e.value * 120}px`,
  opacity: e.value > 0 ? String(Math.max(0, 1 - e.value * 2)) : undefined,
  visibility: e.value > 0.999 ? ('hidden' as const) : undefined,
}))

/** The glass pill under the selected tab. */
const activeIndex = computed(() => Math.max(0, items.findIndex((item) => item.id === tab.value)))
const pillStyle = computed(() => ({ left: `calc(4px + ${activeIndex.value} * (100% - 8px) / ${items.length})` }))

/** Briefly true after a tab change: the pill stretches while it travels. */
const moving = ref(false)
let movingTimer = 0
watch(activeIndex, () => {
  window.clearTimeout(movingTimer)
  moving.value = false
  // Restart the animation even when switching again mid-move.
  requestAnimationFrame(() => {
    moving.value = true
    movingTimer = window.setTimeout(() => (moving.value = false), 600)
  })
})
onBeforeUnmount(() => window.clearTimeout(movingTimer))

/** Fades out as the player expands, like the mini player on top of it. */
const miniStyle = computed(() => ({
  opacity: String(Math.max(0, 1 - e.value * 3)),
  visibility: e.value > 0.4 ? ('hidden' as const) : undefined,
}))

function select(id: (typeof items)[number]['id']) {
  haptic('tick')
  void selectTab(id)
}

async function search() {
  haptic('tick')
  if (tab.value !== 'home') await selectTab('home')
  void navigate({ name: 'search' })
}
</script>

<template>
  <nav class="bottom-nav lg-tabbar" :style="barStyle" aria-label="Main">
    <Glass class="lg-tabbar-tabs" macro regular>
      <div class="lg-tabbar-row" :style="{ '--lg-tabs': items.length }">
        <Glass class="lg-tab-pill" :class="{ 'is-moving': moving }" :style="pillStyle" aria-hidden="true" />
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="lg-tab"
          :class="{ 'is-active': tab === item.id }"
          :aria-current="tab === item.id ? 'page' : undefined"
          @click="select(item.id)"
        >
          <C.MIcon :name="item.icon" :filled="tab === item.id" :size="26" />
          <span class="lg-tab-label">{{ item.label }}</span>
        </button>
      </div>
    </Glass>
    <Glass tag="button" class="lg-tabbar-search" macro regular interactive type="button" aria-label="Search" @click="search">
      <C.MIcon name="search" :size="26" />
    </Glass>
  </nav>
  <Glass v-if="currentSong" class="lg-mini-glass" macro regular :style="miniStyle" aria-hidden="true" />
</template>
