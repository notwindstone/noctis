<script setup lang="ts">
import { computed } from 'vue'
import { cacheEnabled, maxCacheMb } from '../../preferences'
import { formatBytes, usage } from '../../offline'

const total = computed(() => usage.value.download + usage.value.cache)
const percent = (bytes: number) => (total.value > 0 ? Math.round((bytes / total.value) * 100) : 0)
/** A share in words: a little isn't "0%". */
const share = (part: number, whole: number) => {
  const value = whole > 0 ? (part / whole) * 100 : 0
  return value > 0 && value < 1 ? 'under 1%' : `${Math.min(100, Math.round(value))}%`
}
/** The cache is trimmed to its limit, so how full that limit is says when songs start to drop out. */
const cacheLimit = computed(() => (cacheEnabled.value && maxCacheMb.value > 0 ? maxCacheMb.value * 1024 * 1024 : 0))
</script>

<template>
  <!-- Nothing stored is an empty track, not two half bars. -->
  <div class="storage-meter" :class="{ 'is-empty': total === 0 }" aria-hidden="true">
    <span v-if="usage.download > 0" class="storage-meter-download" :style="{ flex: usage.download }" />
    <span v-if="usage.cache > 0" class="storage-meter-cache" :style="{ flex: usage.cache }" />
  </div>
  <div class="storage-legend type-body-medium">
    <span class="storage-legend-item is-download">
      <span class="storage-legend-dot" aria-hidden="true" />
      Downloads • {{ formatBytes(usage.download) }} • {{ percent(usage.download) }}%
    </span>
    <span class="storage-legend-item is-cache">
      <span class="storage-legend-dot" aria-hidden="true" />
      Cache • {{ formatBytes(usage.cache) }} • {{ percent(usage.cache) }}%
    </span>
  </div>
  <p v-if="cacheLimit > 0" class="settings-note type-body-small muted">
    The bar shows how Noctis's storage splits between downloads and cache. The cache is {{ share(usage.cache, cacheLimit) }} of its {{ formatBytes(cacheLimit) }} limit; past it, the songs played longest ago are removed.
  </p>
  <p v-else class="settings-note type-body-small muted">The bar shows how Noctis's storage splits between downloads and cache.</p>
</template>
