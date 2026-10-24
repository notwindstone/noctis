<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, ref, watch } from 'vue'
import { artworkHue } from '../artColor'
import { formatTotal, songCount } from '../format'
import { haptic, tap } from '../haptics'
import type { IconName } from '../icons'
import { navigate } from '../navigation'
import { download, offlineState } from '../offline'
import { playSongs, shufflePlay } from '../player'
import { notify } from '../snackbar'
import { schemeStyle } from '../theme'
import type { ArtistRef, Section, Song } from '../models'
import { useInfiniteScroll } from '../composables'
import { useItemDelegation } from '../itemActions'
import MIcon from './MIcon.vue'
import StateView from './StateView.vue'
import Thumb from './Thumb.vue'

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

const allOffline = computed(() => props.songs.length > 0 && props.songs.every((song) => offlineState(song.id) === 'downloaded'))

function play() {
  haptic('press')
  playSongs(props.songs, 0, props.title)
}

function shuffle() {
  haptic('press')
  shufflePlay(props.songs, props.title)
}

function downloadAll() {
  tap()
  const missing = props.songs.filter((song) => offlineState(song.id) !== 'downloaded')
  if (missing.length === 0) return notify('Everything here is already downloaded')
  notify(`Downloading ${songCount(missing.length)}…`)
  // One at a time keeps memory flat and the connection free for playback.
  void missing.reduce<Promise<void>>((chain, song) => chain.then(() => download(song, 'download')), Promise.resolve())
}

const songActions = useItemDelegation(() => ({ items: props.songs, play: 'list', title: props.title }))

function openArtist(artist: ArtistRef) {
  if (artist.id) void navigate({ name: 'artist', id: artist.id })
}

useInfiniteScroll(sentinel, () => {
  if (props.hasMore && !props.loading) emit('loadMore')
})
</script>

<template>
  <div class="screen collection-screen" :style="tint">
    <div class="collection-tint" aria-hidden="true" />
    <C.TopAppBar :title="title" back :reveal-at="300">
      <template #actions>
        <slot name="actions" />
      </template>
    </C.TopAppBar>

    <StateView v-if="loading && songs.length === 0 && !title" kind="loading" />
    <StateView v-else-if="error && songs.length === 0" kind="error" title="Couldn't load this page" :message="error" action="Try again" @action="emit('retry')" />

    <template v-else>
      <header class="collection-header">
        <div class="collection-art" :class="{ 'is-icon': icon }">
          <MIcon v-if="icon" :name="icon" filled :size="72" />
          <Thumb v-else :src="thumbnail" :size="280" eager icon="album" />
          <span v-if="badge && !icon" class="collection-badge" aria-hidden="true">
            <MIcon :name="badge" filled :size="22" />
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
          <button class="icon-button large tonal" type="button" :aria-label="allOffline ? 'Downloaded' : 'Download all'" :disabled="songs.length === 0" @click="downloadAll">
            <MIcon :name="allOffline ? 'downloaded' : 'download'" />
          </button>
          <button class="filled-button large" type="button" :disabled="songs.length === 0" @click="play">
            <MIcon name="play" filled />
            Play
          </button>
          <button class="tonal-button large" type="button" :disabled="songs.length === 0" @click="shuffle">
            <MIcon name="shuffle" />
            Shuffle
          </button>
          <slot name="extra-actions">
            <button class="icon-button large tonal" type="button" aria-label="Start radio" @click="emit('radio')">
              <MIcon name="radio" />
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

      <div class="collection-songs" @click="songActions.onClick" @contextmenu="songActions.onContextmenu">
        <C.ItemRow
          v-for="(song, index) in songs"
          :key="`${song.id}:${index}`"
          :item="song"
          :index="index"
          :number="numbered ? index + 1 : undefined"
          :subtitle="rowSubtitle?.(song)"
        />
        <StateView v-if="!loading && songs.length === 0" icon="music" :title="emptyTitle" :message="emptyMessage" />
      </div>

      <div ref="sentinel" class="infinite-sentinel">
        <span v-if="loading && songs.length > 0" class="loading-indicator small" aria-label="Loading more" />
      </div>

      <C.SectionView v-for="section in sections" :key="section.id" :section="section" />
      <slot />
    </template>
  </div>
</template>
