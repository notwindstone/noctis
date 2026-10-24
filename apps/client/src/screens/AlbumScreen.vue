<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted } from 'vue'
import { useAsync } from '../composables'
import type { Route } from '../navigation'
import { playRadioFrom, startRadio } from '../player'
import { getAlbum } from '../services/api'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed(() => (props.route.name === 'album' ? props.route.id : ''))

const source = computed(() => (props.route.name === 'album' ? props.route.source : undefined))

const { data, loading, error, run } = useAsync(() => getAlbum(id.value, source.value))
onMounted(run)

function radio() {
  const album = data.value
  if (!album) return
  if (album.playlistId) {
    void playRadioFrom({ kind: 'album', album: { id: album.id, title: album.title }, playlistId: album.playlistId }, `Radio · ${album.title}`, source.value)
  }
  else if (album.songs[0]) void startRadio(album.songs[0])
}
</script>

<template>
  <C.CollectionView
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
