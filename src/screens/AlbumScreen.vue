<script setup lang="ts">
import { computed, onMounted } from 'vue'
import CollectionView from '../components/CollectionView.vue'
import { useAsync } from '../composables'
import type { Route } from '../navigation'
import { playFromQueueSource, startRadio } from '../player'
import { getAlbum } from '../ytm/api'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed(() => (props.route.name === 'album' ? props.route.id : ''))

const { data, loading, error, run } = useAsync(() => getAlbum(id.value))
onMounted(run)

function radio() {
  const album = data.value
  if (!album) return
  if (album.playlistId) void playFromQueueSource({ playlistId: `RDAMPL${album.playlistId}`, title: `Radio · ${album.title}` })
  else if (album.songs[0]) void startRadio(album.songs[0])
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
    :songs="data?.songs ?? []"
    :sections="data?.sections"
    numbered
    :loading="loading"
    :error="error"
    @retry="run"
    @radio="radio"
  />
</template>
