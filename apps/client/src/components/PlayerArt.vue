<script setup lang="ts">
import { C } from '../plugins/components'
import type { Song } from '../models'

/**
 * The artwork area of the full player. It is its own registry entry so a plugin can put
 * something else here (the lyrics plugin shows synced lyrics in its place).
 */
defineProps<{ song: Song }>()
</script>

<template>
  <C.Thumb :src="song.thumbnail" :size="560" shape="rounded" eager />
</template>
