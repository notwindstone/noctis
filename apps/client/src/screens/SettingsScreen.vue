<script setup lang="ts">
import { tap } from '../haptics'
import { navigate, type Route } from '../navigation'
import { C } from '../plugins/components'
import { Sections } from '../plugins/rows'
import { account, hasAccounts, openAccountSettings, signedIn, signInDescription, signInTitle } from '../services/session'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

/** Settings home: the account card, then every visible section (built-in and plugin). */
function open(page: string) {
  void navigate({ name: 'settings-page', page })
}

function openAccount() {
  tap()
  openAccountSettings()
}
</script>

<template>
  <div class="screen settings-screen">
    <C.TopAppBar title="Settings" :reveal-at="56" />
    <h1 class="screen-headline type-headline-large">Settings</h1>

    <button v-if="hasAccounts" class="account-card" type="button" @click="openAccount">
      <C.Thumb v-if="account?.photo" :src="account.photo" :size="56" shape="circle" icon="account" />
      <span v-else class="account-card-icon"><C.MIcon name="account" :size="32" /></span>
      <span class="account-card-text">
        <strong class="type-title-medium">{{ signedIn ? (account?.name ?? 'Signed in') : signInTitle }}</strong>
        <span class="type-body-medium muted">
          {{ signedIn ? (account?.handle ?? 'Your library and recommendations') : signInDescription }}
        </span>
      </span>
      <C.MIcon name="chevron-right" class="settings-row-chevron" />
    </button>

    <div class="settings-group">
      <template v-for="section in Sections" :key="section.id">
        <component
          :is="C.SettingsRow"
          v-if="!section.hidden"
          :icon="section.icon"
          :title="section.title"
          :description="section.description"
          chevron
          @click="open(section.id)"
        />
      </template>
    </div>
  </div>
</template>
