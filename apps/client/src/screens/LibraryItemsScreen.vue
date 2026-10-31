<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref, watch } from 'vue'
import { describeError } from '../composables'
import { useItemDelegation } from '../itemActions'
import { listenedArtists } from '../library'
import type { Route } from '../navigation'
import { getLibraryArtists, getLibraryPlaylists } from '../services/api'
import { newPlaylistDialog, ownPlaylists, playlistsVersion } from '../playlists'
import { activeService, servicesReady } from '../services/registry'
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
  loading.value = true
  error.value = null
  try {
    if (isArtists.value) {
      items.value = hasLibrary.value ? await getLibraryArtists() : []
      if (items.value.length === 0) items.value = listenedArtists.value
    } else {
      // Yours first: made on this device, or on the server when another service's library is shown.
      const own = await ownPlaylists(activeService.value?.id === 'noctis-server')
      items.value = [...own, ...(hasLibrary.value ? await getLibraryPlaylists() : [])]
    }
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)
onSessionChange(load)
watch(playlistsVersion, load)
</script>

<template>
  <div class="screen">
    <C.TopAppBar :title="title" back :reveal-at="48">
      <template v-if="!isArtists" #actions>
        <button class="icon-button" type="button" aria-label="New playlist" @click="newPlaylistDialog()">
          <C.MIcon name="add" />
        </button>
      </template>
    </C.TopAppBar>
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
      <C.ItemCard v-for="(item, index) in items" :key="`${item.type}:${item.source}:${item.id}`" :item="item" :index="index" :width="isArtists ? 120 : 156" />
    </div>
    <C.StateView
      v-else
      :icon="isArtists ? 'artist' : 'playlist'"
      :title="isArtists ? 'No artists yet' : 'No playlists yet'"
      :message="isArtists ? (hasLibrary ? '' : `Sign in to ${serviceName} to see your library.`) : 'Make one with the + button, or add songs to a playlist from their menu.'"
    />
  </div>
</template>
