<script setup lang="ts">
import { ref, watch } from 'vue'
import { C } from '../../plugins/components'

/** A plugin's own image (metadata `logo`), or a symbol when it has none or the image doesn't load. */
const props = withDefaults(defineProps<{ logo?: string; icon?: string; size?: number }>(), { logo: undefined, icon: 'plugin', size: 40 })

const broken = ref(false)
watch(() => props.logo, () => (broken.value = false))
</script>

<template>
  <span class="plugin-icon" :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="logo && !broken" :src="logo" alt="" draggable="false" referrerpolicy="no-referrer" @error="broken = true" />
    <C.MIcon v-else :name="icon" :size="Math.round(size * 0.6)" />
  </span>
</template>
