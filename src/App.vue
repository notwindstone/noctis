<script setup lang="ts">
import { onMounted } from 'vue'
import { initBack } from './back'
import { C } from './plugins/components'
import { setupNavigation } from './navigation'
import { currentSong } from './player'

onMounted(() => {
  setupNavigation()
  initBack()
})
</script>

<template>
  <div class="app" :class="{ 'has-player': currentSong !== null }">
    <!-- Every piece comes from the component registry, so plugins can replace any of them. -->
    <C.ScreenStack />
    <C.PlayerSheet />
    <C.BottomNav />
    <C.SheetHost />
    <C.SnackbarHost />
  </div>
</template>
