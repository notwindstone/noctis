<script setup lang="ts">
import { C } from '../../plugins/components'
import { haptic } from '../../haptics'
import { effectiveColorSource, isDark, oklchHex, SEEDS, seedId, setSeed } from '../../theme'

function swatch(hue: number) {
  return { background: oklchHex(isDark.value ? 80 : 40, 0.14, hue) }
}

function pick(id: string) {
  haptic('tick')
  setSeed(id)
}
</script>

<template>
  <div class="settings-group">
    <div class="seed-row" role="group" aria-label="Preset colours">
      <button
        v-for="item in SEEDS"
        :key="item.id"
        class="seed-swatch"
        type="button"
        :style="swatch(item.hue)"
        :aria-pressed="effectiveColorSource === 'seed' && seedId === item.id"
        :aria-label="item.name"
        @click="pick(item.id)"
      >
        <C.MIcon v-if="effectiveColorSource === 'seed' && seedId === item.id" name="check" :size="20" />
      </button>
    </div>
  </div>
</template>
