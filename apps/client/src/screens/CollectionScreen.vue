<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref } from 'vue'
import { describeError } from '../composables'
import { relativeTime } from '../format'
import type { IconName } from '../icons'
import { clearHistory, history, likedSongs } from '../library'
import type { CollectionId, Route } from '../navigation'
import { cached, clearCache, downloads, formatBytes, usage } from '../offline'
import { confirm } from '../ui'
import { getLikedSongs, loadMoreLikedSongs } from '../services/api'
import { servicesReady } from '../services/registry'
import { onSessionChange, serviceName, syncsLikes } from '../services/session'
import { artistNames, type Song } from '../models'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed<CollectionId>(() => (props.route.name === 'collection' ? props.route.id : 'liked'))

const META: Record<CollectionId, { title: string; icon: IconName; empty: string }> = {
  liked: { title: 'Liked songs', icon: 'favorite', empty: 'Songs you like will show up here.' },
  downloads: { title: 'Downloads', icon: 'downloaded', empty: 'Download songs to listen without a connection.' },
  cached: { title: 'Cached', icon: 'cached', empty: 'Songs you play are cached here automatically.' },
  history: { title: 'Recently played', icon: 'history', empty: 'Songs you play will show up here.' },
}

const meta = computed(() => META[id.value])

/* Liked songs come from the service when it keeps them (YouTube Music, signed in), from the device otherwise. */
const remoteLiked = ref<Song[] | null>(null)
const remoteHasMore = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

async function loadRemote() {
  await servicesReady()
  if (id.value !== 'liked' || !syncsLikes.value) {
    remoteLiked.value = null
    return
  }
  loading.value = true
  error.value = null
  try {
    const page = await getLikedSongs()
    remoteLiked.value = page?.songs ?? null
    if (!page) return
    remoteHasMore.value = page.hasMore
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!remoteHasMore.value || loading.value) return
  loading.value = true
  try {
    const page = await loadMoreLikedSongs()
    remoteLiked.value = [...(remoteLiked.value ?? []), ...page.songs]
    remoteHasMore.value = page.hasMore
  } catch {
    remoteHasMore.value = false
  } finally {
    loading.value = false
  }
}

onMounted(loadRemote)
onSessionChange(loadRemote)

const songs = computed<Song[]>(() => {
  switch (id.value) {
    case 'liked': {
      if (!remoteLiked.value) return likedSongs.value
      // Show local likes that haven't reached the service yet first.
      const remoteIds = new Set(remoteLiked.value.map((song) => song.id))
      return [...likedSongs.value.filter((song) => !remoteIds.has(song.id)), ...remoteLiked.value]
    }
    case 'downloads':
      return downloads.value.map((entry) => entry.song)
    case 'cached':
      return cached.value.map((entry) => entry.song)
    case 'history':
      return history.value.map((entry) => entry.song)
  }
  return []
})

const subtitle = computed(() => {
  switch (id.value) {
    case 'liked':
      return syncsLikes.value ? `Synced with ${serviceName.value}` : 'On this device'
    case 'downloads':
      return `${formatBytes(usage.value.download)} on this device`
    case 'cached':
      return `${formatBytes(usage.value.cache)} · cleared automatically when full`
    case 'history':
      return 'On this device'
  }
  return ''
})

const playedAt = computed(() => new Map(history.value.map((entry) => [entry.song.id, entry.playedAt])))

const rowSubtitle = computed(() =>
  id.value === 'history'
    ? (song: Song) => {
        const time = playedAt.value.get(song.id)
        return [artistNames(song.artists), time ? relativeTime(time) : ''].filter(Boolean).join(' • ')
      }
    : undefined,
)

function clearAll() {
  if (id.value === 'history') {
    confirm({
      title: 'Clear listening history?',
      message: 'This removes your on-device history. History kept by streaming services is not affected.',
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: clearHistory,
    })
  } else if (id.value === 'cached') {
    confirm({
      title: 'Clear cache?',
      message: 'Cached songs will be streamed again next time you play them.',
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: clearCache,
    })
  }
}
</script>

<template>
  <C.CollectionView
    :title="meta.title"
    :subtitle="subtitle"
    :thumbnail="songs[0]?.thumbnail"
    :icon="songs.length === 0 ? meta.icon : undefined"
    :badge="meta.icon"
    :songs="songs"
    :loading="loading"
    :error="error"
    :has-more="remoteHasMore"
    :empty-message="meta.empty"
    :row-subtitle="rowSubtitle"
    @retry="loadRemote"
    @load-more="loadMore"
  >
    <template #actions>
      <button
        v-if="(id === 'history' || id === 'cached') && songs.length > 0"
        class="icon-button"
        type="button"
        :aria-label="id === 'history' ? 'Clear history' : 'Clear cache'"
        @click="clearAll"
      >
        <C.MIcon name="delete" />
      </button>
    </template>
    <template #extra-actions>
      <span />
    </template>
  </C.CollectionView>
</template>
