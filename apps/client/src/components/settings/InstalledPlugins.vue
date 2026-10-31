<script setup lang="ts">
import { C } from '../../plugins/components'
import { installedPlugins, isEnabled, type InstalledPlugin } from '../../plugins/store'
import PluginIcon from './PluginIcon.vue'

/**
 * Settings → Plugins → Installed. Besides opening a plugin, each row has a switch and a
 * delete button, so neither needs a trip to the plugin's page. The row's actions are
 * siblings of the open button (a button can't hold buttons), and the page's functions are
 * passed in because they live next to the confirmation dialogs.
 */
defineProps<{
  icon(plugin: InstalledPlugin): string
  description(plugin: InstalledPlugin): string
  open(plugin: InstalledPlugin): void
  toggle(plugin: InstalledPlugin, value: boolean): void
  remove(plugin: InstalledPlugin): void
}>()
</script>

<template>
  <div v-if="installedPlugins.length > 0" class="settings-group">
    <div v-for="plugin in installedPlugins" :key="plugin.id" class="installed-plugin">
      <button class="settings-row installed-plugin-open" type="button" @click="open(plugin)">
        <span class="settings-row-icon"><PluginIcon :logo="plugin.metadata.logo" :icon="icon(plugin)" :size="40" /></span>
        <span class="settings-row-text">
          <span class="type-body-large">{{ plugin.metadata.name }}</span>
          <span class="type-body-medium muted">{{ description(plugin) }}</span>
        </span>
      </button>
      <button
        class="switch installed-plugin-switch"
        :class="{ 'is-on': isEnabled(plugin) }"
        type="button"
        role="switch"
        :aria-checked="isEnabled(plugin)"
        :aria-label="`${plugin.metadata.name} enabled`"
        @click="toggle(plugin, !isEnabled(plugin))"
      >
        <span><C.MIcon v-if="isEnabled(plugin)" name="check" :size="16" /></span>
      </button>
      <button class="icon-button installed-plugin-remove" type="button" :aria-label="`Remove ${plugin.metadata.name}`" @click="remove(plugin)">
        <C.MIcon name="delete" />
      </button>
    </div>
  </div>
</template>
