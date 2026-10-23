<script setup lang="ts">
import { onMounted } from 'vue'
import BottomNav from './components/BottomNav.vue'
import PlayerSheet from './components/PlayerSheet.vue'
import ScreenStack from './components/ScreenStack.vue'
import SheetHost from './components/SheetHost.vue'
import SnackbarHost from './components/SnackbarHost.vue'
import { initBack } from './back'
import { setupNavigation } from './navigation'
import { currentSong } from './player'
import { account, playerInnertube, refreshAccount, signedIn } from './ytm/client'
import { prewarmPoToken } from './ytm/potoken'

onMounted(() => {
  setupNavigation()
  initBack()
  if (signedIn.value && !account.value) void refreshAccount()
  // Loading YouTube's player script and BotGuard takes a few seconds; do it before the
  // first tap on a song rather than after.
  window.setTimeout(() => {
    void playerInnertube().catch(() => {})
    prewarmPoToken()
  }, 1500)
})
</script>

<template>
  <div class="app" :class="{ 'has-player': currentSong !== null }">
    <ScreenStack />
    <PlayerSheet />
    <BottomNav />
    <SheetHost />
    <SnackbarHost />
  </div>
</template>
