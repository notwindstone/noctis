<script setup lang="ts">
import { computed } from 'vue'
import { ICON_VIEWBOX, ICONS, type IconName } from '../icons'

const props = withDefaults(
  defineProps<{
    name: IconName
    size?: number
    filled?: boolean
  }>(),
  { size: 24, filled: false },
)

const path = computed(() => {
  const icon = ICONS[props.name]
  return props.filled ? icon.filled : icon.outlined
})
</script>

<template>
  <svg
    class="m-icon"
    :width="size"
    :height="size"
    :viewBox="ICON_VIEWBOX"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="path" />
  </svg>
</template>
