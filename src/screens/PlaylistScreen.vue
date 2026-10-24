<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CollectionView from '../components/CollectionView.vue'
import { useAsync } from '../composables'
import type { Route } from '../navigation'
import { playRadioFrom } from '../player'
import { getPlaylist, loadMorePlaylist } from '../services/api'
import type { Song } from '../models'

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
  void playRadioFrom({ kind: 'playlist', playlist: { id: id.value, title: data.value.title } }, `Radio · ${data.value.title}`, source.value)
}
</script>

<template>
  <CollectionView
    :title="data?.title ?? ''"
    :subtitle="data?.subtitle"
    :second-subtitle="data?.secondSubtitle"
    :description="data?.description"
    :thumbnail="data?.thumbnail"
    :artists="data?.artists"
    :songs="songs"
    :loading="loading || loadingMore"
    :error="error"
    :has-more="hasMore"
    @retry="run"
    @load-more="loadMore"
    @radio="radio"
  />
</template>
