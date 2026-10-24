<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted } from 'vue'
import SettingsBlocks from '../components/settings/SettingsBlocks.vue'
import StateView from '../components/StateView.vue'
import type { Route } from '../navigation'
import { findSection, Rows } from '../plugins/rows'
import { activeService } from '../services/registry'
import { refreshAccount, signedIn } from '../services/session'

/** One settings section, built-in or from a plugin; its content is data in `Rows`. */
const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const id = computed(() => (props.route.name === 'settings-page' ? props.route.page : ''))
const section = computed(() => findSection(id.value))
const blocks = computed(() => Rows[id.value])

onMounted(() => {
  // Opening the account page re-reads the account's name and picture.
  if (id.value === activeService.value?.service.account?.section && signedIn.value) void refreshAccount()
})
</script>

<template>
  <div class="screen settings-page">
    <C.TopAppBar :title="section?.title ?? ''" back :reveal-at="48" />
    <h1 class="screen-headline type-headline-medium">{{ section?.title }}</h1>
    <SettingsBlocks v-if="blocks" :blocks="blocks" />
    <StateView v-else icon="info" title="This page is no longer available" message="The plugin that added it was removed." />
  </div>
</template>
