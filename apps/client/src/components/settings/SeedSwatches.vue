<script setup lang="ts">
import { C } from '../../plugins/components'
import { haptic } from '../../haptics'
import { CUSTOM_SEED, customColor, effectiveColorSource, isDark, oklchHex, SEEDS, seedId, setCustomColor, setSeed } from '../../theme'

function swatch(hue: number) {
  return { background: oklchHex(isDark.value ? 80 : 40, 0.14, hue) }
}

const customActive = () => effectiveColorSource.value === 'seed' && seedId.value === CUSTOM_SEED

function pickCustom(event: Event) {
  setCustomColor((event.target as HTMLInputElement).value)
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
      <!-- The native colour chooser sits invisibly over the swatch, so a tap opens it. -->
      <label class="seed-swatch seed-custom" :style="{ background: customColor }" :aria-pressed="customActive()" aria-label="Custom colour">
        <C.MIcon :name="customActive() ? 'check' : 'palette'" :size="20" />
        <input type="color" :value="customColor" aria-label="Custom colour" @input="pickCustom" />
      </label>
    </div>
  </div>
</template>
