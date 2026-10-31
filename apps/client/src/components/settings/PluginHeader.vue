<script setup lang="ts">
import { computed } from 'vue'
import { findPlugin } from '../../plugins/store'
import PluginIcon from './PluginIcon.vue'

/** Top of a plugin's page: its icon, name and id (the id is what other plugins' manifests refer to). */
const props = defineProps<{ id: string }>()
const plugin = computed(() => findPlugin(props.id))
</script>

<template>
  <div v-if="plugin" class="plugin-header">
    <PluginIcon :logo="plugin.metadata.logo" :size="72" />
    <strong class="type-headline-small">{{ plugin.metadata.name }}</strong>
    <code class="plugin-header-id type-body-medium muted">{{ plugin.id }}</code>
  </div>
</template>
