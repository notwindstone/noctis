<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref, watch } from 'vue'
import { useAsync } from '../composables'
import type { Route } from '../navigation'
import { goBack } from '../navigation'
import { playRadioFrom } from '../player'
import { deletePlaylist, LOCAL_PLAYLISTS, playlistsVersion, renamePlaylist } from '../playlists'
import { getPlaylist, loadMorePlaylist } from '../services/api'
import type { Playlist, Song } from '../models'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed(() => (props.route.name === 'playlist' ? props.route.id : ''))
const source = computed(() => (props.route.name === 'playlist' ? props.route.source : undefined))

const extra = ref<Song[]>([])
const hasMore = ref(false)
const loadingMore = ref(false)

const { data, loading, error, run } = useAsync(async () => {
  const page = await getPlaylist(id.value, source.value)
  extra.value = []
  hasMore.value = page.hasMore
  return page
})
onMounted(run)
// Songs added or removed, or the playlist renamed, from anywhere.
watch(playlistsVersion, run)

const isLocal = computed(() => source.value === LOCAL_PLAYLISTS)
const editable = computed(() => data.value?.editable === true)
const asItem = computed<Playlist | null>(() =>
  data.value ? { type: 'playlist', source: source.value, id: id.value, title: data.value.title, editable: true } : null,
)

const songs = computed(() => [...(data.value?.songs ?? []), ...extra.value])

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const page = await loadMorePlaylist(id.value, source.value)
    extra.value = [...extra.value, ...page.songs]
    hasMore.value = page.hasMore
  } catch {
    hasMore.value = false
  } finally {
    loadingMore.value = false
  }
}

function radio() {
  if (!data.value) return
  void playRadioFrom({ kind: 'playlist', playlist: { id: id.value, title: data.value.title } }, `Radio • ${data.value.title}`, source.value)
}
</script>

<template>
  <C.CollectionView
    :title="data?.title ?? ''"
    :subtitle="data?.subtitle"
    :second-subtitle="data?.secondSubtitle"
    :description="data?.description"
    :thumbnail="data?.thumbnail ?? songs.find((song) => song.thumbnail)?.thumbnail"
    placeholder="playlist"
    :artists="data?.artists"
    :songs="songs"
    :loading="loading || loadingMore"
    :error="error"
    :has-more="hasMore"
    @retry="run"
    @load-more="loadMore"
    :editable-playlist="editable ? { id, source } : undefined"
    @radio="radio"
  >
    <template v-if="editable && asItem" #actions>
      <button class="icon-button" type="button" aria-label="Rename playlist" @click="renamePlaylist(asItem)">
        <C.MIcon name="edit" />
      </button>
      <button class="icon-button" type="button" aria-label="Delete playlist" @click="deletePlaylist(asItem, goBack)">
        <C.MIcon name="delete" />
      </button>
    </template>
    <!-- A list you made has no radio of its own. -->
    <template v-if="isLocal" #extra-actions><span /></template>
  </C.CollectionView>
</template>
