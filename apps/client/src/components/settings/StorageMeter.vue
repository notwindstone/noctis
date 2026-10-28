<script setup lang="ts">
import { computed } from 'vue'
import { cacheEnabled, maxCacheMb } from '../../preferences'
import { formatBytes, usage } from '../../offline'

const total = computed(() => usage.value.download + usage.value.cache)
const percent = (bytes: number) => (total.value > 0 ? Math.round((bytes / total.value) * 100) : 0)
/** The cache is trimmed to its limit, so how full that limit is says when songs start to drop out. */
const cacheLimit = computed(() => (cacheEnabled.value && maxCacheMb.value > 0 ? maxCacheMb.value * 1024 * 1024 : 0))
</script>

<template>
  <div class="storage-meter" aria-hidden="true">
    <span class="storage-meter-download" :style="{ flex: Math.max(usage.download, 1) }" />
    <span class="storage-meter-cache" :style="{ flex: Math.max(usage.cache, 1) }" />
  </div>
  <div class="storage-legend type-body-medium">
    <span class="storage-legend-item is-download">
      <span class="storage-legend-dot" aria-hidden="true" />
      Downloads · {{ formatBytes(usage.download) }} · {{ percent(usage.download) }}%
    </span>
    <span class="storage-legend-item is-cache">
      <span class="storage-legend-dot" aria-hidden="true" />
      Cache · {{ formatBytes(usage.cache) }} · {{ percent(usage.cache) }}%
    </span>
  </div>
  <p v-if="cacheLimit > 0" class="settings-note type-body-small muted">
    The bar shows how Noctis's storage splits between downloads and cache. The cache is {{ Math.min(100, Math.round((usage.cache / cacheLimit) * 100)) }}% of its {{ formatBytes(cacheLimit) }} limit; past it, the songs played longest ago are removed.
  </p>
  <p v-else class="settings-note type-body-small muted">The bar shows how Noctis's storage splits between downloads and cache.</p>
</template>
