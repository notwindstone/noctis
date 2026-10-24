<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref } from 'vue'
import { describeError } from '../composables'
import { useItemDelegation } from '../itemActions'
import { listenedArtists } from '../library'
import type { Route } from '../navigation'
import { getLibraryArtists, getLibraryPlaylists } from '../services/api'
import { servicesReady } from '../services/registry'
import { hasLibrary, onSessionChange, serviceName } from '../services/session'
import type { Item } from '../models'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const isArtists = computed(() => props.route.name === 'library-artists')
const title = computed(() => (isArtists.value ? 'Your artists' : 'Your playlists'))

const items = ref<Item[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const actions = useItemDelegation(() => ({ items: items.value }))

async function load() {
  await servicesReady()
  if (!hasLibrary.value) {
    items.value = isArtists.value ? listenedArtists.value : []
    return
  }
  loading.value = true
  error.value = null
  try {
    items.value = isArtists.value ? await getLibraryArtists() : await getLibraryPlaylists()
    if (isArtists.value && items.value.length === 0) items.value = listenedArtists.value
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)
onSessionChange(load)
</script>

<template>
  <div class="screen">
    <C.TopAppBar :title="title" back :reveal-at="48" />
    <h1 class="screen-headline type-headline-medium">{{ title }}</h1>
    <C.StateView v-if="loading && items.length === 0" kind="loading" />
    <C.StateView v-else-if="error" kind="error" :message="error" action="Try again" @action="load" />
    <div
      v-else-if="items.length > 0"
      class="item-grid"
      :class="{ 'is-artists': isArtists }"
      @click="actions.onClick"
      @contextmenu="actions.onContextmenu"
    >
      <C.ItemCard v-for="(item, index) in items" :key="`${item.type}:${item.id}`" :item="item" :index="index" :width="isArtists ? 120 : 156" />
    </div>
    <C.StateView
      v-else
      :icon="isArtists ? 'artist' : 'playlist'"
      :title="isArtists ? 'No artists yet' : 'No playlists yet'"
      :message="hasLibrary ? '' : `Sign in to ${serviceName} to see your library.`"
    />
  </div>
</template>
