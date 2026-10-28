<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { describeError, useInfiniteScroll } from '../composables'
import { haptic, tap } from '../haptics'
import { history } from '../library'
import { navigate, type Route } from '../navigation'
import { downloads } from '../offline'
import { readPageCache, writePageCache } from '../pageCache'
import { usePullToRefresh } from '../pullToRefresh'
import { notify } from '../snackbar'
import { loadHome, loadMoreHome } from '../services/api'
import { activeService, servicesReady } from '../services/registry'
import { credentials } from '../subsonic/client'
import { handshake, otherServerName, serverStatus, serverUrl } from '../server'
import { account, onSessionChange, openAccountSettings, signedIn } from '../services/session'
import type { HomeResult, Section } from '../models'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const sections = ref<Section[]>([])
const filters = ref<string[]>([])
const selectedFilter = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const hasMore = ref(false)
const loadingMore = ref(false)
const sentinel = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)

/** On-device rows shown while signed out, where the service has nothing personal to offer. */
const localSections = computed<Section[]>(() => {
  if (signedIn.value || selectedFilter.value) return []
  const rows: Section[] = []
  if (history.value.length > 0) {
    rows.push({
      id: 'local-history',
      title: 'Listen again',
      strapline: 'On this device',
      layout: 'carousel',
      items: history.value.slice(0, 16).map((entry) => entry.song),
    })
  }
  if (downloads.value.length > 0) {
    rows.push({
      id: 'local-downloads',
      title: 'Your downloads',
      layout: 'carousel',
      items: downloads.value.slice(0, 16).map((entry) => entry.song),
    })
  }
  return rows
})

function apply(result: HomeResult) {
  sections.value = result.sections
  filters.value = result.filters
  selectedFilter.value = result.selectedFilter
  hasMore.value = result.hasMore
}

/**
 * Fetch the home feed. `quiet` keeps what's on screen while it loads (pull-to-refresh)
 * and reports failures as a snackbar instead of replacing the page with an error.
 */
async function load(filter: string | null = selectedFilter.value, quiet = false) {
  if (!quiet) loading.value = true
  error.value = null
  try {
    const result = await loadHome(filter)
    apply(result)
    writePageCache<HomeResult>('home', result)
  } catch (cause) {
    if (quiet && sections.value.length > 0) notify(`Couldn't refresh: ${describeError(cause)}`)
    else error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

/** Resolves to whether it added rows, so the scroll observer looks again if the page still isn't full. */
async function loadMore(): Promise<boolean> {
  if (!hasMore.value || loading.value || loadingMore.value) return false
  loadingMore.value = true
  try {
    const result = await loadMoreHome(selectedFilter.value)
    sections.value = [...sections.value, ...result.sections]
    hasMore.value = result.hasMore
    return result.sections.length > 0 || result.hasMore
  } catch (cause) {
    // Keep `hasMore`: the next time the end comes into view it tries again, instead of the feed stopping for good.
    notify(`Couldn't load more: ${describeError(cause)}`)
    return false
  } finally {
    loadingMore.value = false
  }
}

function selectFilter(filter: string) {
  haptic('tick')
  const next = selectedFilter.value === filter ? null : filter
  selectedFilter.value = next
  void load(next)
}

/** No plugin provides a service yet: a fresh install, not a failure. */
const noService = computed(() => error.value !== null && !activeService.value)

/** Connected to a server (e.g. the one this web client came from) but not signed in. */
const needsSignIn = computed(() => noService.value && Boolean(serverUrl.value) && (serverStatus.value === 'connected' || serverStatus.value === 'needs-plugins') && !credentials.value)
const serverName = computed(() => handshake.value?.server.name ?? (otherServerName.value || serverUrl.value.replace(/^https?:\/\//, '')))

function openServer() {
  tap()
  void navigate({ name: 'settings-page', page: 'server' })
}

function openPlugins() {
  tap()
  void navigate({ name: 'settings-page', page: 'plugins' })
}

function openAccount() {
  tap()
  openAccountSettings()
}

const { pull, dragging, refreshing } = usePullToRefresh(root, () => load(selectedFilter.value, true))

const { recheck } = useInfiniteScroll(sentinel, loadMore)

// A page that was skipped while loading (the first fetch, a cached feed) still needs its rows.
watch(loading, (isLoading) => {
  if (!isLoading) void nextTick(recheck)
})

// Open straight into the last fetched feed; only fetch when there's nothing cached.
onMounted(async () => {
  await servicesReady()
  const cached = readPageCache<HomeResult>('home')
  if (cached) {
    apply(cached)
    loading.value = false
  } else {
    void load()
  }
})

// Different service, account, language or region: the cached feed no longer applies.
onSessionChange(() => void load(null))
</script>

<template>
  <div ref="root" class="screen home-screen">
    <C.RefreshIndicator :pull="pull" :dragging="dragging" :refreshing="refreshing" />
    <header class="home-top">
      <button class="search-bar" type="button" @click="navigate({ name: 'search' })">
        <C.MIcon name="search" />
        <span>Search songs, albums, artists</span>
      </button>
      <button class="avatar-button" type="button" aria-label="Account" @click="openAccount">
        <C.Thumb v-if="account?.photo" :src="account.photo" :size="36" shape="circle" icon="account" />
        <C.MIcon v-else name="account" :size="28" />
      </button>
    </header>

    <div v-if="filters.length > 0" class="chip-row" role="group" aria-label="Moods">
      <button
        v-for="filter in filters"
        :key="filter"
        class="chip"
        type="button"
        :aria-pressed="selectedFilter === filter"
        @click="selectFilter(filter)"
      >
        <C.MIcon v-if="selectedFilter === filter" name="check" :size="18" />
        {{ filter }}
      </button>
    </div>

    <C.SectionView v-for="section in localSections" :key="section.id" :section="section" />

    <template v-if="loading && sections.length === 0">
      <div v-for="index in 3" :key="index" class="skeleton-section" aria-hidden="true">
        <span class="skeleton skeleton-title" />
        <div class="skeleton-row">
          <span v-for="card in 4" :key="card" class="skeleton skeleton-card" />
        </div>
      </div>
    </template>

    <C.StateView
      v-else-if="needsSignIn && sections.length === 0"
      icon="server"
      :title="`Sign in to ${serverName}`"
      message="Your library, playlists and recommendations are waiting on the server."
      action="Sign in"
      @action="openServer"
    />

    <C.StateView
      v-else-if="noService && sections.length === 0"
      icon="info"
      title="No music services yet"
      message="Noctis gets its music from plugins. Install one, like YouTube Music, to fill your home feed."
      action="Open plugins"
      @action="openPlugins"
    />

    <C.StateView
      v-else-if="error && sections.length === 0"
      kind="error"
      title="Couldn't load your home feed"
      :message="error"
      action="Try again"
      @action="load()"
    />

    <div v-else class="home-sections" :class="{ 'is-refreshing': loading }">
      <C.SectionView v-for="section in sections" :key="section.id" :section="section" />
    </div>

    <div ref="sentinel" class="infinite-sentinel">
      <span v-if="loadingMore" class="loading-indicator small" aria-label="Loading more" />
    </div>
  </div>
</template>
