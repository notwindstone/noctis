<script setup lang="ts">
import { computed } from 'vue'
import { haptic } from '../haptics'
import type { IconName } from '../icons'
import { selectTab, tab, type TabId } from '../navigation'
import { playerExpansion } from '../ui'
import MIcon from './MIcon.vue'

const items: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

/** The bar slides away as the player expands over it. */
const style = computed(() => ({
  transform: `translate3d(0, ${playerExpansion.value * 100}%, 0)`,
  visibility: playerExpansion.value > 0.999 ? ('hidden' as const) : undefined,
}))

function select(id: TabId) {
  haptic('tick')
  void selectTab(id)
}
</script>

<template>
  <nav class="bottom-nav" :style="style" aria-label="Main">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="bottom-nav-item"
      :aria-current="tab === item.id ? 'page' : undefined"
      @click="select(item.id)"
    >
      <span class="bottom-nav-indicator">
        <MIcon :name="item.icon" :filled="tab === item.id" />
      </span>
      <span class="bottom-nav-label">{{ item.label }}</span>
    </button>
  </nav>
</template>
