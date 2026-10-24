<script setup lang="ts">
import { computed } from 'vue'
import { clearLog, pluginLog } from '../../plugins/log'

/** The plugin system's log, optionally for one plugin. Newest entries at the bottom. */
const props = defineProps<{ source?: string }>()

const entries = computed(() =>
  props.source ? pluginLog.value.filter((entry) => entry.source === props.source) : pluginLog.value,
)

const time = (value: number) => new Date(value).toLocaleTimeString()
</script>

<template>
  <div class="plugin-log">
    <div v-if="entries.length === 0" class="plugin-log-empty type-body-medium muted">Nothing logged yet.</div>
    <ol v-else class="plugin-log-list">
      <li v-for="(entry, index) in entries" :key="index" class="plugin-log-entry" :class="`is-${entry.level}`">
        <span class="plugin-log-meta">{{ time(entry.time) }}<template v-if="!source"> · {{ entry.source }}</template></span>
        <span class="plugin-log-message">{{ entry.message }}</span>
      </li>
    </ol>
    <button v-if="entries.length > 0" class="text-button" type="button" @click="clearLog(source)">Clear log</button>
  </div>
</template>
