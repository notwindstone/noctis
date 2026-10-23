<script setup lang="ts">
import MIcon from '../components/MIcon.vue'
import SettingsRow from '../components/SettingsRow.vue'
import Thumb from '../components/Thumb.vue'
import TopAppBar from '../components/TopAppBar.vue'
import { tap } from '../haptics'
import type { IconName } from '../icons'
import { navigate, type Route, type SettingsPage } from '../navigation'
import { account, signedIn } from '../ytm/client'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const rows: { page: SettingsPage; icon: IconName; title: string; description: string }[] = [
  { page: 'appearance', icon: 'palette', title: 'Appearance', description: 'Theme, dynamic colour, player' },
  { page: 'playback', icon: 'equalizer', title: 'Playback', description: 'Audio quality, queue, autoplay' },
  { page: 'content', icon: 'language', title: 'Content', description: 'Language and region' },
  { page: 'storage', icon: 'storage', title: 'Storage', description: 'Downloads, cache and history' },
  { page: 'about', icon: 'info', title: 'About', description: 'Version and credits' },
]

function open(page: SettingsPage) {
  void navigate({ name: 'settings-page', page })
}

function openAccount() {
  tap()
  open('account')
}
</script>

<template>
  <div class="screen settings-screen">
    <TopAppBar title="Settings" :reveal-at="56" />
    <h1 class="screen-headline type-headline-large">Settings</h1>

    <button class="account-card" type="button" @click="openAccount">
      <Thumb v-if="account?.photo" :src="account.photo" :size="56" shape="circle" icon="account" />
      <span v-else class="account-card-icon"><MIcon name="account" :size="32" /></span>
      <span class="account-card-text">
        <strong class="type-title-medium">{{ signedIn ? (account?.name ?? 'Signed in') : 'Sign in to YouTube Music' }}</strong>
        <span class="type-body-medium muted">
          {{ signedIn ? (account?.handle ?? 'Your library and recommendations') : 'Get your playlists, likes and personal mixes' }}
        </span>
      </span>
      <MIcon name="chevron-right" class="settings-row-chevron" />
    </button>

    <div class="settings-group">
      <SettingsRow
        v-for="row in rows"
        :key="row.page"
        :icon="row.icon"
        :title="row.title"
        :description="row.description"
        chevron
        @click="open(row.page)"
      />
    </div>
  </div>
</template>
