<script setup lang="ts">
import { dismissSnackbar, snackbarMessage } from '../snackbar'
import MIcon from './MIcon.vue'
</script>

<template>
  <Transition name="snackbar">
    <div v-if="snackbarMessage" class="snackbar" role="status" aria-live="polite">
      <span>{{ snackbarMessage }}</span>
      <button
        class="icon-button"
        type="button"
        aria-label="Dismiss message"
        @click="dismissSnackbar"
      >
        <MIcon name="close" :size="20" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.snackbar .icon-button {
  color: inherit;
}
</style>
