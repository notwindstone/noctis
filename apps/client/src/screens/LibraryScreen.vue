<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted, ref, watch } from 'vue'
import { songCount } from '../format'
import { tap } from '../haptics'
import { t } from '../i18n'
import type { IconName } from '../icons'
import { useItemDelegation } from '../itemActions'
import { history, likedSongs, listenedArtists } from '../library'
import { canAddFolders, localTracks, loadLocalLibrary } from '../local/library'
import { navigate, type CollectionId, type Route } from '../navigation'
import { cached, downloads, formatBytes, usage } from '../offline'
import { readPageCache, writePageCache } from '../pageCache'
import { usePullToRefresh } from '../pullToRefresh'
import { notify } from '../snackbar'
import { getLibraryArtists, getLibraryPlaylists } from '../services/api'
import { LOCAL_PLAYLISTS, newPlaylistDialog, localPlaylistItems, ownPlaylists, playlistsVersion } from '../playlists'
import { activeService, servicesReady } from '../services/registry'
import {
  account,
  hasAccounts,
  hasLibrary,
  onSessionChange,
  openAccountSettings,
  refreshAccount,
  serviceName,
  signedIn,
  syncsLikes,
} from '../services/session'
import type { Artist, Item, Playlist } from '../models'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const playlists = ref<Playlist[]>([])
/** Playlists on the server when another service's library is the one shown. */
const serverLists = ref<Playlist[]>([])
const artists = ref<Artist[]>([])
const loadingRemote = ref(false)
const remoteError = ref(false)

interface LibraryCache {
  playlists: Playlist[]
  artists: Artist[]
}

const root = ref<HTMLElement | null>(null)

/** Fetch the account's playlists and artists. `quiet` keeps the current ones on failure. */
async function loadRemote(quiet = false) {
  if (!hasLibrary.value) {
    playlists.value = []
    artists.value = []
    return
  }
  if (!quiet) loadingRemote.value = true
  remoteError.value = false
  try {
    const [lists, people] = await Promise.all([getLibraryPlaylists(), getLibraryArtists()])
    playlists.value = lists as Playlist[]
    artists.value = people as Artist[]
    writePageCache<LibraryCache>('library', { playlists: playlists.value, artists: artists.value })
  } catch {
    if (quiet && playlists.value.length > 0) notify("Couldn't refresh your library")
    else remoteError.value = true
  } finally {
    loadingRemote.value = false
  }
}

async function loadServerLists() {
  // The server's own library already lists them when it is the active service.
  serverLists.value = activeService.value?.id === 'noctis-server' ? [] : (await ownPlaylists(false)).filter((item) => item.source !== LOCAL_PLAYLISTS)
}

// Playlists made, changed or deleted anywhere.
watch(playlistsVersion, () => {
  void loadServerLists()
  if (activeService.value?.id === 'noctis-server') void loadRemote(true)
})

const { pull, dragging, refreshing } = usePullToRefresh(root, () =>
  Promise.all([loadRemote(true), signedIn.value ? refreshAccount() : null]),
)

// Open straight into the last fetched library; only fetch when there's nothing cached.
onMounted(async () => {
  void loadLocalLibrary()
  void loadServerLists()
  await servicesReady()
  const cached = hasLibrary.value ? readPageCache<LibraryCache>('library') : null
  if (cached) {
    playlists.value = cached.playlists
    artists.value = cached.artists
  } else {
    void loadRemote()
  }
})

// Different service, account, language or region: the cached library no longer applies.
onSessionChange(() => void loadRemote())

const fromAccount = computed(() => hasLibrary.value && artists.value.length > 0)
const shownArtists = computed<Artist[]>(() => (fromAccount.value ? artists.value : listenedArtists.value))

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
    // Kept by the service: its count isn't known here, but where they are is.
    detail: syncsLikes.value ? `On ${serviceName.value}` : songCount(likedSongs.value.length),
    icon: 'favorite',
  },
  {
    id: 'downloads',
    title: 'Downloads',
    detail: downloads.value.length ? `${songCount(downloads.value.length)} • ${formatBytes(usage.value.download)}` : 'Offline songs',
    icon: 'downloaded',
  },
  {
    id: 'cached',
    title: 'Cached',
    detail: cached.value.length ? `${songCount(cached.value.length)} • ${formatBytes(usage.value.cache)}` : 'Played songs',
    icon: 'cached',
  },
  {
    id: 'history',
    title: 'Recently played',
    detail: history.value.length ? songCount(history.value.length) : 'Nothing yet',
    icon: 'history',
  },
  // Only where there's music, or a way to add some.
  ...(localTracks.value.length > 0 || canAddFolders
    ? [
        {
          id: 'local' as const,
          title: 'Local music',
          detail: localTracks.value.length ? songCount(localTracks.value.length) : 'Add music',
          icon: 'device-music' as const,
        },
      ]
    : []),
])

const recent = computed<Item[]>(() => history.value.slice(0, 12).map((entry) => entry.song))

const allPlaylists = computed(() => [...localPlaylistItems.value, ...serverLists.value, ...playlists.value])
const shownPlaylists = computed(() => allPlaylists.value.slice(0, 20))
const showSignIn = computed(() => !hasLibrary.value && hasAccounts.value && !signedIn.value)
const artistCards = computed(() => shownArtists.value.slice(0, 20))
const playlistActions = useItemDelegation(() => ({ items: shownPlaylists.value }))
const artistActions = useItemDelegation(() => ({ items: artistCards.value }))
const recentActions = useItemDelegation(() => ({ items: recent.value }))

function open(id: CollectionId) {
  tap()
  // Nothing to show yet: go where music is added.
  if (id === 'local' && localTracks.value.length === 0) return void navigate({ name: 'settings-page', page: 'local-music' })
  void navigate({ name: 'collection', id })
}
</script>

<template>
  <div ref="root" class="screen library-screen">
    <C.RefreshIndicator :pull="pull" :dragging="dragging" :refreshing="refreshing" />
    <C.TopAppBar :title="t('Library')" :reveal-at="56">
      <template #actions>
        <button v-if="hasAccounts" class="avatar-button" type="button" aria-label="Account" @click="openAccountSettings">
          <C.Thumb v-if="account?.photo" :src="account.photo" :size="32" shape="circle" icon="account" />
          <C.MIcon v-else name="account" :size="26" />
        </button>
      </template>
    </C.TopAppBar>
    <h1 class="screen-headline type-headline-large">{{ t('Library') }}</h1>

    <div class="library-tiles">
      <button v-for="tile in tiles" :key="tile.id" class="library-tile" :class="`tile-${tile.id}`" type="button" @click="open(tile.id)">
        <span class="library-tile-icon"><C.MIcon :name="tile.icon" filled /></span>
        <span class="library-tile-text">
          <strong class="type-title-medium">{{ t(tile.title) }}</strong>
          <span class="type-body-small">{{ tile.detail }}</span>
        </span>
      </button>
    </div>

    <section class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" @click="navigate({ name: 'library-playlists' })">
          <span class="section-title type-title-large">{{ t('Your playlists') }}</span>
        </button>
        <button class="icon-button" type="button" aria-label="New playlist" @click="newPlaylistDialog()">
          <C.MIcon name="add" />
        </button>
        <button class="icon-button" type="button" aria-label="All playlists" @click="navigate({ name: 'library-playlists' })">
          <C.MIcon name="chevron-right" />
        </button>
      </header>

      <div v-if="showSignIn" class="signin-card">
        <C.MIcon name="playlist" :size="28" />
        <div>
          <p class="type-title-medium">Your {{ serviceName }} playlists</p>
          <p class="type-body-medium muted">Sign in to see playlists, liked music and artists from your account.</p>
        </div>
        <button class="filled-button" type="button" @click="openAccountSettings">Sign in</button>
      </div>
      <div v-if="loadingRemote && allPlaylists.length === 0" class="skeleton-row" aria-hidden="true">
        <span v-for="card in 4" :key="card" class="skeleton skeleton-card" />
      </div>
      <p v-else-if="remoteError && allPlaylists.length === 0" class="type-body-medium muted section-note">
        Couldn't load your playlists. <button class="link-button" type="button" @click="loadRemote()">Retry</button>
      </p>
      <div v-else-if="allPlaylists.length > 0" class="carousel" @click="playlistActions.onClick" @contextmenu="playlistActions.onContextmenu">
        <C.ItemCard v-for="(item, index) in shownPlaylists" :key="`${item.source}:${item.id}`" :item="item" :index="index" />
      </div>
      <p v-else-if="!showSignIn" class="type-body-medium muted section-note">
        You haven't made any playlists yet. <button class="link-button" type="button" @click="newPlaylistDialog()">Create one</button>
      </p>
    </section>

    <section v-if="shownArtists.length > 0" class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" @click="navigate({ name: 'library-artists' })">
          <span v-if="!fromAccount" class="section-strapline type-label-medium">From your listening</span>
          <span class="section-title type-title-large">{{ t('Your artists') }}</span>
        </button>
        <button class="icon-button" type="button" aria-label="All artists" @click="navigate({ name: 'library-artists' })">
          <C.MIcon name="chevron-right" />
        </button>
      </header>
      <div class="carousel" @click="artistActions.onClick" @contextmenu="artistActions.onContextmenu">
        <C.ItemCard v-for="(item, index) in artistCards" :key="item.id" :item="item" :index="index" :width="112" />
      </div>
    </section>

    <section v-if="recent.length > 0" class="home-section">
      <header class="section-header">
        <button class="section-header-text" type="button" @click="open('history')">
          <span class="section-title type-title-large">{{ t('Recently played') }}</span>
        </button>
        <button class="icon-button" type="button" aria-label="All recently played" @click="open('history')">
          <C.MIcon name="chevron-right" />
        </button>
      </header>
      <div class="carousel" @click="recentActions.onClick" @contextmenu="recentActions.onContextmenu">
        <C.ItemCard v-for="(item, index) in recent" :key="item.id" :item="item" :index="index" />
      </div>
    </section>
  </div>
</template>
