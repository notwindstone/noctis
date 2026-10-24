<script setup lang="ts">
import { usage } from '../../offline'
</script>

<template>
  <div class="storage-meter" aria-hidden="true">
    <span class="storage-meter-download" :style="{ flex: Math.max(usage.download, 1) }" />
    <span class="storage-meter-cache" :style="{ flex: Math.max(usage.cache, 1) }" />
  </div>
</template>
