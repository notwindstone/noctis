<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { artworkHue } from '../artColor'
import ItemRow from '../components/ItemRow.vue'
import MIcon from '../components/MIcon.vue'
import SectionView from '../components/SectionView.vue'
import StateView from '../components/StateView.vue'
import Thumb from '../components/Thumb.vue'
import TopAppBar from '../components/TopAppBar.vue'
import { useAsync } from '../composables'
import { haptic } from '../haptics'
import { useItemDelegation } from '../itemActions'
import { openBrowse, type Route } from '../navigation'
import { playFromQueueSource } from '../player'
import { schemeStyle } from '../theme'
import { getArtist } from '../ytm/api'
import type { Song } from '../ytm/models'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const id = computed(() => (props.route.name === 'artist' ? props.route.id : ''))

const { data, loading, error, run } = useAsync(() => getArtist(id.value))
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

/** The first list shelf is "Top songs"; show it as a playable list, the rest as rows. */
const topSongs = computed(() => data.value?.sections.find((section) => section.layout === 'list') ?? null)
const topSongList = computed(() => (topSongs.value?.items ?? []).filter((item): item is Song => item.type === 'song'))
const otherSections = computed(() => data.value?.sections.filter((section) => section !== topSongs.value) ?? [])

const topSongActions = useItemDelegation(() => ({ items: topSongList.value, play: 'list', title: data.value?.name }))

function shuffle() {
  const page = data.value
  if (!page?.shuffle) return
  haptic('press')
  void playFromQueueSource({ ...page.shuffle, title: page.name })
}

function radio() {
  const page = data.value
  if (!page?.radio) return
  haptic('press')
  void playFromQueueSource({ ...page.radio, title: `${page.name} radio` })
}
</script>

<template>
  <div class="screen artist-screen" :style="tint">
    <TopAppBar :title="data?.name ?? ''" back overlay :reveal-at="260" />

    <StateView v-if="loading && !data" kind="loading" />
    <StateView v-else-if="error && !data" kind="error" title="Couldn't load this artist" :message="error" action="Try again" @action="run" />

    <template v-else-if="data">
      <header class="artist-hero">
        <Thumb class="artist-hero-image" :src="data.thumbnail" :size="720" shape="square" icon="artist" eager />
        <div class="artist-hero-fade" aria-hidden="true" />
        <h1 class="artist-name type-display-small">{{ data.name }}</h1>
      </header>

      <div class="artist-actions">
        <button class="filled-button large" type="button" :disabled="!data.shuffle" @click="shuffle">
          <MIcon name="shuffle" />
          Shuffle
        </button>
        <button class="tonal-button large" type="button" :disabled="!data.radio" @click="radio">
          <MIcon name="radio" />
          Radio
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
            <MIcon name="chevron-right" />
          </button>
        </header>
        <div class="section-list" @click="topSongActions.onClick" @contextmenu="topSongActions.onContextmenu">
          <ItemRow v-for="(song, index) in topSongList" :key="song.id" :item="song" :index="index" />
        </div>
      </section>

      <SectionView v-for="section in otherSections" :key="section.id" :section="section" />
    </template>
  </div>
</template>
