<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, nextTick, ref, watch } from 'vue'
import { artworkHue } from '../artColor'
import { formatTime, formatTotal, songCount } from '../format'
import { haptic, tap } from '../haptics'
import type { IconName } from '../icons'
import { navigate } from '../navigation'
import { download, isOnDevice, notDownloadable, offlineState, transfers } from '../offline'
import { playSongs, shufflePlay } from '../player'
import { gridDetails, gridNumbers, gridSize, songLayout, type GridSize } from '../preferences'
import { notify } from '../snackbar'
import { isStationSong } from '../stations'
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
    /** The artwork's placeholder while it loads, or when there's none. */
    placeholder?: IconName
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
    /** Set when the songs are a playlist of yours: each song's menu offers "Remove from this playlist". */
    editablePlaylist?: { id: string; source?: string }
    /** Song row subtitle override, e.g. "3 hr ago" in history. */
    rowSubtitle?: (song: Song) => string | undefined
  }>(),
  {
    subtitle: '',
    secondSubtitle: '',
    description: '',
    thumbnail: undefined,
    icon: undefined,
    placeholder: 'album',
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
    editablePlaylist: undefined,
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

const GRID_SIZES: { value: GridSize; label: string; width: number }[] = [
  { value: 'small', label: 'Small cards', width: 120 },
  { value: 'medium', label: 'Medium cards', width: 160 },
  { value: 'large', label: 'Large cards', width: 220 },
]
const gridCard = computed(() => GRID_SIZES.find((size) => size.value === gridSize.value)!)

function toggleLayout() {
  tap()
  songLayout.value = songLayout.value === 'grid' ? 'list' : 'grid'
}

function chooseGridSize() {
  tap()
  showChoice({
    title: 'Card size',
    options: GRID_SIZES.map(({ value, label }) => ({ value, label })),
    value: gridSize.value,
    onSelect: (value) => (gridSize.value = value as GridSize),
  })
}

/** Songs that are files on this device, or already downloaded: nothing left to fetch. Stations can't be saved, so they don't count against it. */
const haveOffline = (song: Song) => isOnDevice(song) || offlineState(song.id) === 'downloaded' || isStationSong(song)
const allOffline = computed(() => props.songs.some((song) => !isStationSong(song)) && props.songs.every(haveOffline))

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

/**
 * The icon tile: asked for, or for a collection with an identity of its own (a badge: ♥, ⬇…)
 * whose artwork turned out not to exist (servers give every song a cover address).
 */
const artFailed = ref(false)
watch(() => props.thumbnail, () => (artFailed.value = false))
const tileIcon = computed(() => props.icon ?? (artFailed.value ? props.badge : undefined))

/** This page's songs still in the download queue, for the ring on the download button. */
const downloadProgress = computed(() => {
  const pending = props.songs.filter((song) => transfers.get(song.id)?.kind === 'download')
  if (pending.length === 0) return null
  const done = props.songs.filter((song) => offlineState(song.id) === 'downloaded').length
  const running = pending.reduce((sum, song) => sum + (transfers.get(song.id)?.progress ?? 0), 0)
  return { left: pending.length, fraction: (done + running) / (done + pending.length) }
})

const downloadLabel = computed(() => {
  if (downloadProgress.value) return `Downloading, ${songCount(downloadProgress.value.left)} left`
  return allOffline.value ? 'Downloaded' : 'Download all'
})

/**
 * Album pages: the album's own artist goes without saying, so a track's second line is
 * its length, plus its artists when they differ (features, compilations).
 */
const albumArtists = computed(() => artistNames(props.artists))
function trackLine(song: Song) {
  const names = artistNames(song.artists)
  return [names !== albumArtists.value ? names : '', song.duration ? formatTime(song.duration) : ''].filter(Boolean).join(' • ')
}

const songActions = useItemDelegation(() => ({ items: ordered.value, play: 'list', title: props.title, playlist: props.editablePlaylist }))

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
        <div class="collection-art" :class="{ 'is-icon': tileIcon }">
          <C.MIcon v-if="tileIcon" :name="tileIcon" filled :size="72" />
          <C.Thumb v-else :src="thumbnail" :size="280" eager :icon="placeholder" @failed="artFailed = true" />
          <span v-if="badge && !tileIcon" class="collection-badge" aria-hidden="true">
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
          <button class="icon-button large tonal" type="button" :aria-label="downloadLabel" :title="downloadLabel" :disabled="songs.length === 0 || gatheringAll" @click="downloadAll">
            <svg v-if="downloadProgress" class="progress-ring large" viewBox="0 0 20 20" :style="{ '--p': downloadProgress.fraction }" aria-hidden="true">
              <circle class="progress-ring-track" cx="10" cy="10" r="8" />
              <circle class="progress-ring-arc" cx="10" cy="10" r="8" />
            </svg>
            <C.MIcon v-else :name="allOffline ? 'downloaded' : 'download'" />
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

      <slot name="before-songs" />

      <div v-if="songs.length > 1" class="collection-sort">
        <button class="text-button" type="button" @click="chooseSort">
          <C.MIcon name="sort" :size="20" />
          {{ sortOrder === 'default' ? 'Sort' : SORTS.find((sort) => sort.value === sortOrder)?.label }}
        </button>
        <div class="collection-layout">
          <template v-if="songLayout === 'grid'">
            <button class="text-button" type="button" @click="chooseGridSize">{{ gridCard.label }}</button>
            <button class="text-button" type="button" :aria-pressed="gridDetails" @click="gridDetails = !gridDetails">
              <C.MIcon name="check" :size="18" :style="{ visibility: gridDetails ? 'visible' : 'hidden' }" />
              Details
            </button>
            <button v-if="numbered" class="text-button" type="button" :aria-pressed="gridNumbers" @click="gridNumbers = !gridNumbers">
              <C.MIcon name="check" :size="18" :style="{ visibility: gridNumbers ? 'visible' : 'hidden' }" />
              Numbers
            </button>
          </template>
          <button
            class="icon-button"
            type="button"
            :aria-label="songLayout === 'grid' ? 'Show as a list' : 'Show as a grid'"
            :title="songLayout === 'grid' ? 'Show as a list' : 'Show as a grid'"
            @click="toggleLayout"
          >
            <C.MIcon :name="songLayout === 'grid' ? 'list' : 'grid'" :size="22" />
          </button>
        </div>
      </div>

      <div
        v-if="songLayout === 'grid' && songs.length > 1"
        class="collection-songs collection-grid"
        :style="{ '--collection-card': `${gridCard.width}px` }"
        @click="songActions.onClick"
        @contextmenu="songActions.onContextmenu"
      >
        <C.ItemCard
          v-for="(song, index) in ordered"
          :key="`${song.id}:${index}`"
          :item="song"
          :index="index"
          :width="gridCard.width"
          fluid
          :number="numbered && gridNumbers ? index + 1 : undefined"
          :hide-subtitle="!gridDetails"
          :subtitle="rowSubtitle?.(song) ?? (numbered ? trackLine(song) : undefined)"
        />
      </div>

      <div v-else class="collection-songs" @click="songActions.onClick" @contextmenu="songActions.onContextmenu">
        <C.ItemRow
          v-for="(song, index) in ordered"
          :key="`${song.id}:${index}`"
          :item="song"
          :index="index"
          :number="numbered ? index + 1 : undefined"
          :subtitle="rowSubtitle?.(song) ?? (numbered ? trackLine(song) : undefined)"
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
