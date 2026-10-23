<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ItemCard from '../components/ItemCard.vue'
import MIcon from '../components/MIcon.vue'
import Thumb from '../components/Thumb.vue'
import TopAppBar from '../components/TopAppBar.vue'
import { songCount } from '../format'
import { tap } from '../haptics'
import type { IconName } from '../icons'
import { useItemDelegation } from '../itemActions'
import { history, likedSongs, listenedArtists } from '../library'
import { navigate, type CollectionId, type Route } from '../navigation'
import { cached, downloads, formatBytes, usage } from '../offline'
import { getLibraryArtists, getLibraryPlaylists } from '../ytm/api'
import { account, sessionVersion, signedIn } from '../ytm/client'
import type { Artist, Item, Playlist } from '../ytm/models'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const playlists = ref<Playlist[]>([])
const artists = ref<Artist[]>([])
const loadingRemote = ref(false)
const remoteError = ref(false)

async function loadRemote() {
  if (!signedIn.value) {
    playlists.value = []
    artists.value = []
    return
  }
  loadingRemote.value = true
  remoteError.value = false
  try {
    const [lists, people] = await Promise.all([getLibraryPlaylists(), getLibraryArtists()])
    playlists.value = lists as Playlist[]
    artists.value = people as Artist[]
  } catch {
    remoteError.value = true
  } finally {
    loadingRemote.value = false
  }
}

onMounted(loadRemote)
watch(sessionVersion, loadRemote)

const shownArtists = computed<Artist[]>(() => (signedIn.value && artists.value.length > 0 ? artists.value : listenedArtists.value))

interface Tile {
  id: CollectionId
  title: string
  detail: string
  icon: IconName
}

const tiles = computed<Tile[]>(() => [
  {
    id: 'liked',
    title: 'Liked songs',
    detail: signedIn.value ? 'Synced' : songCount(likedSongs.value.length),
    icon: 'favorite',
  },
  {
    id: 'downloads',
    title: 'Downloads',
    detail: downloads.value.length ? `${songCount(downloads.value.length)} · ${formatBytes(usage.value.download)}` : 'Offline songs',
    icon: 'downloaded',
  },
  {
    id: 'cached',
    title: 'Cached',
    detail: cached.value.length ? `${songCount(cached.value.length)} · ${formatBytes(usage.value.cache)}` : 'Played songs',
    icon: 'cached',
  },
  {
    id: 'history',
    title: 'Recently played',
    detail: history.value.length ? songCount(history.value.length) : 'Nothing yet',
    icon: 'history',
  },
])

const recent = computed<Item[]>(() => history.value.slice(0, 12).map((entry) => entry.song))

const shownPlaylists = computed(() => playlists.value.slice(0, 20))
const artistCards = computed(() => shownArtists.value.slice(0, 20))
const playlistActions = useItemDelegation(() => ({ items: shownPlaylists.value }))
const artistActions = useItemDelegation(() => ({ items: artistCards.value }))
const recentActions = useItemDelegation(() => ({ items: recent.value }))

function open(id: CollectionId) {
  tap()
  void navigate({ name: 'collection', id })
}
</script>

<template>
  <div class="screen library-screen">
    <TopAppBar title="Library" :reveal-at="56">
      <template #actions>
        <button class="avatar-button" type="button" aria-label="Account" @click="navigate({ name: 'settings-page', page: 'account' })">
          <Thumb v-if="account?.photo" :src="account.photo" :size="32" shape="circle" icon="account" />
          <MIcon v-else name="account" :size="26" />
        </button>
      </template>
    </TopAppBar>
    <h1 class="screen-headline type-headline-large">Library</h1>

    <div class="library-tiles">
      <button v-for="tile in tiles" :key="tile.id" class="library-tile" :class="`tile-${tile.id}`" type="button" @click="open(tile.id)">
        <span class="library-tile-icon"><MIcon :name="tile.icon" filled /></span>
        <span class="library-tile-text">
          <strong class="type-title-medium">{{ tile.title }}</strong>
          <span class="type-body-small">{{ tile.detail }}</span>
        </span>
      </button>
    </div>

    <section class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" :disabled="!signedIn" @click="navigate({ name: 'library-playlists' })">
          <span class="section-title type-title-large">Your playlists</span>
        </button>
        <button v-if="signedIn" class="icon-button" type="button" aria-label="All playlists" @click="navigate({ name: 'library-playlists' })">
          <MIcon name="chevron-right" />
        </button>
      </header>

      <div v-if="!signedIn" class="signin-card">
        <MIcon name="playlist" :size="28" />
        <div>
          <p class="type-title-medium">Your YouTube Music playlists</p>
          <p class="type-body-medium muted">Sign in to see playlists, liked music and artists from your account.</p>
        </div>
        <button class="filled-button" type="button" @click="navigate({ name: 'settings-page', page: 'account' })">Sign in</button>
      </div>
      <div v-else-if="loadingRemote && playlists.length === 0" class="skeleton-row" aria-hidden="true">
        <span v-for="card in 4" :key="card" class="skeleton skeleton-card" />
      </div>
      <p v-else-if="remoteError" class="type-body-medium muted section-note">
        Couldn't load your playlists. <button class="link-button" type="button" @click="loadRemote">Retry</button>
      </p>
      <div v-else-if="playlists.length > 0" class="carousel" @click="playlistActions.onClick" @contextmenu="playlistActions.onContextmenu">
        <ItemCard v-for="(item, index) in shownPlaylists" :key="item.id" :item="item" :index="index" />
      </div>
      <p v-else class="type-body-medium muted section-note">You haven't saved any playlists yet.</p>
    </section>

    <section v-if="shownArtists.length > 0" class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" @click="navigate({ name: 'library-artists' })">
          <span v-if="!signedIn" class="section-strapline type-label-medium">From your listening</span>
          <span class="section-title type-title-large">Your artists</span>
        </button>
        <button class="icon-button" type="button" aria-label="All artists" @click="navigate({ name: 'library-artists' })">
          <MIcon name="chevron-right" />
        </button>
      </header>
      <div class="carousel" @click="artistActions.onClick" @contextmenu="artistActions.onContextmenu">
        <ItemCard v-for="(item, index) in artistCards" :key="item.id" :item="item" :index="index" :width="112" />
      </div>
    </section>

    <section v-if="recent.length > 0" class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" @click="open('history')">
          <span class="section-title type-title-large">Recently played</span>
        </button>
        <button class="icon-button" type="button" aria-label="All recently played" @click="open('history')">
          <MIcon name="chevron-right" />
        </button>
      </header>
      <div class="carousel" @click="recentActions.onClick" @contextmenu="recentActions.onContextmenu">
        <ItemCard v-for="(item, index) in recent" :key="item.id" :item="item" :index="index" />
      </div>
    </section>
  </div>
</template>
