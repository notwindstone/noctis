<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, nextTick, ref, watch } from 'vue'
import { artworkHue } from '../artColor'
import { formatTotal, songCount } from '../format'
import { haptic, tap } from '../haptics'
import type { IconName } from '../icons'
import { navigate } from '../navigation'
import { download, isOnDevice, notDownloadable, offlineState } from '../offline'
import { playSongs, shufflePlay } from '../player'
import { notify } from '../snackbar'
import { schemeStyle } from '../theme'
import { showChoice } from '../ui'
import { artistNames, type ArtistRef, type Section, type Song } from '../models'
import { useInfiniteScroll } from '../composables'
import { useItemDelegation } from '../itemActions'

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    secondSubtitle?: string
    description?: string
    thumbnail?: string
    /** Icon tile instead of artwork (local collections with nothing in them yet). */
    icon?: IconName
    /** Small icon over the artwork, so a collection keeps its identity (♥, ⬇…). */
    badge?: IconName
    artists?: ArtistRef[]
    songs: Song[]
    numbered?: boolean
    loading?: boolean
    error?: string | null
    hasMore?: boolean
    sections?: Section[]
    emptyTitle?: string
    emptyMessage?: string
    /** Song row subtitle override, e.g. "3 hr ago" in history. */
    rowSubtitle?: (song: Song) => string | undefined
  }>(),
  {
    subtitle: '',
    secondSubtitle: '',
    description: '',
    thumbnail: undefined,
    icon: undefined,
    badge: undefined,
    artists: () => [],
    numbered: false,
    loading: false,
    error: null,
    hasMore: false,
    sections: () => [],
    emptyTitle: 'Nothing here yet',
    emptyMessage: '',
    rowSubtitle: undefined,
  },
)

const emit = defineEmits<{ loadMore: []; retry: []; radio: [] }>()

const sentinel = ref<HTMLElement | null>(null)
const hue = ref<number | null>(null)
const expanded = ref(false)

watch(
  () => props.thumbnail,
  async (url) => {
    hue.value = await artworkHue(url)
  },
  { immediate: true },
)

const tint = computed(() => (hue.value === null ? {} : schemeStyle(hue.value)))

const meta = computed(() => {
  if (props.secondSubtitle) return props.secondSubtitle
  if (props.songs.length === 0) return ''
  const total = props.songs.reduce((sum, song) => sum + (song.duration ?? 0), 0)
  return [songCount(props.songs.length), total > 0 ? formatTotal(total) : ''].filter(Boolean).join(' • ')
})

type SortOrder = 'default' | 'title' | 'artist' | 'album' | 'plays' | 'longest' | 'shortest'

const SORTS: { value: SortOrder; label: string }[] = [
  { value: 'default', label: 'Default ordering' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'plays', label: 'Most played' },
  { value: 'longest', label: 'Longest first' },
  { value: 'shortest', label: 'Shortest first' },
]

const sortOrder = ref<SortOrder>('default')
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** What is shown, played and downloaded: the songs in the chosen order (a stable sort, so ties keep the page's order). */
const ordered = computed(() => {
  const order = sortOrder.value
  if (order === 'default') return props.songs
  const key: Record<Exclude<SortOrder, 'default'>, (a: Song, b: Song) => number> = {
    title: (a, b) => compare(a.title, b.title),
    artist: (a, b) => compare(artistNames(a.artists), artistNames(b.artists)),
    album: (a, b) => compare(a.album?.name ?? '', b.album?.name ?? ''),
    plays: (a, b) => (b.plays ?? -1) - (a.plays ?? -1),
    longest: (a, b) => (b.duration ?? 0) - (a.duration ?? 0),
    shortest: (a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity),
  }
  return [...props.songs].sort(key[order])
})

function chooseSort() {
  tap()
  showChoice({
    title: 'Sort',
    // "Most played" only when the service gave counts for this list.
    options: SORTS.filter((sort) => sort.value !== 'plays' || props.songs.some((song) => song.plays !== undefined)),
    value: sortOrder.value,
    onSelect: (value) => (sortOrder.value = value as SortOrder),
  })
}

/** Songs that are files on this device, or already downloaded: nothing left to fetch. */
const haveOffline = (song: Song) => isOnDevice(song) || offlineState(song.id) === 'downloaded'
const allOffline = computed(() => props.songs.length > 0 && props.songs.every(haveOffline))

function play() {
  haptic('press')
  playSongs(ordered.value, 0, props.title)
}

function shuffle() {
  haptic('press')
  shufflePlay(ordered.value, props.title)
}

/** Resolves once the parent has finished a page request (it flips `loading` on and back off). */
function nextPage() {
  return new Promise<void>((resolve) => {
    const stop = watch(
      () => [props.loading, props.songs.length, props.hasMore] as const,
      ([loading]) => {
        if (loading) return
        stop()
        resolve()
      },
    )
    emit('loadMore')
    // A parent that ignores the request (nothing more to load) would never wake the watcher.
    void nextTick(() => {
      if (!props.loading && !props.hasMore) {
        stop()
        resolve()
      }
    })
  })
}

const gatheringAll = ref(false)

async function downloadAll() {
  tap()
  if (gatheringAll.value) return
  // Long playlists arrive a page at a time; "all" means all of them, not the ones scrolled into view.
  if (props.hasMore) {
    gatheringAll.value = true
    notify('Loading the whole list…')
    try {
      for (let guard = 0; props.hasMore && guard < 500; guard++) {
        const before = props.songs.length
        await nextPage()
        if (props.songs.length === before && props.hasMore) break
      }
    } finally {
      gatheringAll.value = false
    }
  }
  const wanted = ordered.value.filter((song) => !haveOffline(song))
  // Stations and over-long songs (Settings → Storage) are left out rather than failing one by one.
  const missing = wanted.filter((song) => !notDownloadable(song))
  const left = wanted.length - missing.length
  if (left > 0 && missing.length > 0) notify(`Skipping ${left} ${left === 1 ? 'song' : 'songs'} that can't be downloaded (stations, very long songs)`)
  else if (left > 0) return notify(`Nothing to download: ${left === 1 ? 'it is a station or too long' : 'they are stations or too long'}`)
  if (missing.length === 0) return notify(props.songs.every(isOnDevice) ? 'These songs are already on this device' : 'Everything here is already downloaded')
  // The queue paces them (Settings → Storage, and each service's own limits).
  for (const song of missing) void download(song, 'download')
}

const songActions = useItemDelegation(() => ({ items: ordered.value, play: 'list', title: props.title }))

function openArtist(artist: ArtistRef) {
  if (artist.id) void navigate({ name: 'artist', id: artist.id })
}

const { recheck } = useInfiniteScroll(sentinel, () => {
  if (props.hasMore && !props.loading) emit('loadMore')
})

// The next page arrived and the end of the list is still in view: ask again.
watch(
  () => props.loading,
  (isLoading) => {
    if (!isLoading && props.hasMore) void nextTick(recheck)
  },
)
</script>

<template>
  <div class="screen collection-screen" :style="tint">
    <div class="collection-tint" aria-hidden="true" />
    <C.TopAppBar :title="title" back :reveal-at="300">
      <template #actions>
        <slot name="actions" />
      </template>
    </C.TopAppBar>

    <C.StateView v-if="loading && songs.length === 0 && !title" kind="loading" />
    <C.StateView v-else-if="error && songs.length === 0" kind="error" title="Couldn't load this page" :message="error" action="Try again" @action="emit('retry')" />

    <template v-else>
      <header class="collection-header">
        <div class="collection-art" :class="{ 'is-icon': icon }">
          <C.MIcon v-if="icon" :name="icon" filled :size="72" />
          <C.Thumb v-else :src="thumbnail" :size="280" eager icon="album" />
          <span v-if="badge && !icon" class="collection-badge" aria-hidden="true">
            <C.MIcon :name="badge" filled :size="22" />
          </span>
        </div>
        <h1 class="type-headline-medium collection-title">{{ title }}</h1>
        <p v-if="artists.length > 0" class="collection-artists type-title-medium">
          <template v-for="(artist, index) in artists" :key="index">
            <button v-if="artist.id" type="button" class="link-button" @click="openArtist(artist)">{{ artist.name }}</button>
            <span v-else>{{ artist.name }}</span>
            <span v-if="index < artists.length - 1">, </span>
          </template>
        </p>
        <p v-if="subtitle" class="type-body-medium muted">{{ subtitle }}</p>
        <p v-if="meta" class="type-body-medium muted">{{ meta }}</p>

        <div class="collection-actions">
          <button class="icon-button large tonal" type="button" :aria-label="allOffline ? 'Downloaded' : 'Download all'" :disabled="songs.length === 0 || gatheringAll" @click="downloadAll">
            <C.MIcon :name="allOffline ? 'downloaded' : 'download'" />
          </button>
          <button class="filled-button large" type="button" :disabled="songs.length === 0" @click="play">
            <C.MIcon name="play" filled />
            Play
          </button>
          <button class="tonal-button large" type="button" :disabled="songs.length === 0" @click="shuffle">
            <C.MIcon name="shuffle" />
            Shuffle
          </button>
          <slot name="extra-actions">
            <button class="icon-button large tonal" type="button" aria-label="Start radio" @click="emit('radio')">
              <C.MIcon name="radio" />
            </button>
          </slot>
        </div>

        <p
          v-if="description"
          class="collection-description type-body-medium"
          :class="{ 'is-expanded': expanded }"
          @click="expanded = !expanded"
        >
          {{ description }}
        </p>
      </header>

      <div v-if="songs.length > 1" class="collection-sort">
        <button class="text-button" type="button" @click="chooseSort">
          <C.MIcon name="sort" :size="20" />
          {{ sortOrder === 'default' ? 'Sort' : SORTS.find((sort) => sort.value === sortOrder)?.label }}
        </button>
      </div>

      <div class="collection-songs" @click="songActions.onClick" @contextmenu="songActions.onContextmenu">
        <C.ItemRow
          v-for="(song, index) in ordered"
          :key="`${song.id}:${index}`"
          :item="song"
          :index="index"
          :number="numbered ? index + 1 : undefined"
          :subtitle="rowSubtitle?.(song)"
        />
        <C.StateView v-if="!loading && songs.length === 0" icon="music" :title="emptyTitle" :message="emptyMessage" />
      </div>

      <div ref="sentinel" class="infinite-sentinel">
        <span v-if="loading && songs.length > 0" class="loading-indicator small" aria-label="Loading more" />
      </div>

      <C.SectionView v-for="section in sections" :key="section.id" :section="section" />
      <slot />
    </template>
  </div>
</template>
