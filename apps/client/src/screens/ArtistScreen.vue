<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref, watch } from 'vue'
import { artworkHue } from '../artColor'
import { useAsync } from '../composables'
import { haptic } from '../haptics'
import { useItemDelegation } from '../itemActions'
import { openBrowse, type Route } from '../navigation'
import { playFromQueueSource, playSongs, shufflePlay, startRadio } from '../player'
import { schemeStyle } from '../theme'
import { getArtist } from '../services/api'
import type { Song } from '../models'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed(() => (props.route.name === 'artist' ? props.route.id : ''))

const source = computed(() => (props.route.name === 'artist' ? props.route.source : undefined))

const { data, loading, error, run } = useAsync(() => getArtist(id.value, source.value))
onMounted(run)

const hue = ref<number | null>(null)
watch(
  () => data.value?.thumbnail,
  async (url) => {
    hue.value = await artworkHue(url)
  },
)
const tint = computed(() => (hue.value === null ? {} : schemeStyle(hue.value)))

const expanded = ref(false)

/** Servers hand out a cover address for every artist, picture or not: a failed one counts as none. */
const photoFailed = ref(false)
watch(() => data.value?.thumbnail, () => (photoFailed.value = false))
const hasPhoto = computed(() => Boolean(data.value?.thumbnail) && !photoFailed.value)

/** The first list shelf is "Top songs"; show it as a playable list, the rest as rows. */
const topSongs = computed(() => data.value?.sections.find((section) => section.layout === 'list') ?? null)
const topSongList = computed(() => (topSongs.value?.items ?? []).filter((item): item is Song => item.type === 'song'))
const otherSections = computed(() => data.value?.sections.filter((section) => section !== topSongs.value) ?? [])

const topSongActions = useItemDelegation(() => ({ items: topSongList.value, play: 'list', title: data.value?.name }))

/*
 * The same three actions as an album page. A service without an artist shuffle or radio
 * (most OpenSubsonic servers) gets them from the top songs instead of greyed-out buttons.
 */
const canPlay = computed(() => topSongList.value.length > 0)
const canShuffle = computed(() => Boolean(data.value?.shuffle) || topSongList.value.length > 1)
const canRadio = computed(() => Boolean(data.value?.radio) || topSongList.value.length > 0)

function play() {
  const page = data.value
  if (!page || !canPlay.value) return
  haptic('press')
  playSongs(topSongList.value, 0, page.name)
}

function shuffle() {
  const page = data.value
  if (!page) return
  haptic('press')
  if (page.shuffle) void playFromQueueSource({ ...page.shuffle, title: page.name, source: source.value })
  else shufflePlay(topSongList.value, page.name)
}

function radio() {
  const page = data.value
  if (!page) return
  haptic('press')
  if (page.radio) void playFromQueueSource({ ...page.radio, title: `${page.name} radio`, source: source.value })
  else if (topSongList.value[0]) void startRadio(topSongList.value[0])
}

/** On the artist's own page their name goes without saying: the album, plus anyone featured. */
function topSongLine(song: Song) {
  const others = song.artists.filter((artist) => (artist.id ? artist.id !== id.value : artist.name !== data.value?.name))
  return [others.map((artist) => artist.name).join(', '), song.album?.name].filter(Boolean).join(' • ')
}
</script>

<template>
  <div class="screen artist-screen" :style="tint">
    <C.TopAppBar :title="data?.name ?? ''" back overlay :reveal-at="260" />

    <C.StateView v-if="loading && !data" kind="loading" />
    <C.StateView v-else-if="error && !data" kind="error" title="Couldn't load this artist" :message="error" action="Try again" @action="run" />

    <template v-else-if="data">
      <!-- Without a photo: the page's tint and a round placeholder, not a screen-sized icon. -->
      <div v-if="!hasPhoto" class="collection-tint" aria-hidden="true" />
      <header class="artist-hero" :class="{ 'no-image': !hasPhoto }">
        <template v-if="hasPhoto">
          <C.Thumb class="artist-hero-image" :src="data.thumbnail" :size="720" shape="square" icon="artist" eager />
          <div class="artist-hero-fade" aria-hidden="true" />
        </template>
        <div class="artist-hero-text">
          <!-- Wide windows blur the photo into a backdrop and show it sharp here (main.css). -->
          <C.Thumb
            class="artist-hero-portrait"
            :src="data.thumbnail"
            :size="320"
            shape="circle"
            icon="artist"
            eager
            @failed="photoFailed = true"
            @loaded="photoFailed = false"
          />
          <h1 class="artist-name type-display-small">{{ data.name }}</h1>
        </div>
      </header>

      <div v-if="canPlay || canShuffle || canRadio" class="collection-actions artist-actions">
        <button v-if="canPlay" class="filled-button large" type="button" @click="play">
          <C.MIcon name="play" filled />
          Play
        </button>
        <button v-if="canShuffle" class="tonal-button large" type="button" @click="shuffle">
          <C.MIcon name="shuffle" />
          Shuffle
        </button>
        <button v-if="canRadio" class="icon-button large tonal" type="button" aria-label="Start radio" title="Start radio" @click="radio">
          <C.MIcon name="radio" />
        </button>
      </div>

      <p
        v-if="data.description"
        class="collection-description artist-description type-body-medium"
        :class="{ 'is-expanded': expanded }"
        @click="expanded = !expanded"
      >
        {{ data.description }}
      </p>

      <section v-if="topSongs" class="home-section">
        <header class="section-header">
          <button class="section-header-text" type="button" :disabled="!topSongs.more" @click="topSongs.more && openBrowse(topSongs.more, topSongs.title)">
            <span class="section-title type-title-large">{{ topSongs.title || 'Top songs' }}</span>
          </button>
          <button v-if="topSongs.more" class="icon-button" type="button" aria-label="All songs" @click="openBrowse(topSongs.more!, topSongs.title)">
            <C.MIcon name="chevron-right" />
          </button>
        </header>
        <div class="section-list" @click="topSongActions.onClick" @contextmenu="topSongActions.onContextmenu">
          <C.ItemRow v-for="(song, index) in topSongList" :key="song.id" :item="song" :index="index" :subtitle="topSongLine(song)" />
        </div>
      </section>

      <C.SectionView v-for="section in otherSections" :key="section.id" :section="section" />
    </template>
  </div>
</template>
