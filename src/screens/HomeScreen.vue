<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import MIcon from '../components/MIcon.vue'
import SectionView from '../components/SectionView.vue'
import StateView from '../components/StateView.vue'
import Thumb from '../components/Thumb.vue'
import { describeError, useInfiniteScroll } from '../composables'
import { haptic, tap } from '../haptics'
import { history } from '../library'
import { navigate, type Route } from '../navigation'
import { downloads } from '../offline'
import { loadHome, loadMoreHome } from '../ytm/api'
import { account, sessionVersion, signedIn } from '../ytm/client'
import type { Section } from '../ytm/models'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const sections = ref<Section[]>([])
const filters = ref<string[]>([])
const selectedFilter = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const hasMore = ref(false)
const loadingMore = ref(false)
const sentinel = ref<HTMLElement | null>(null)

/** On-device rows shown while signed out, where YouTube has nothing personal to offer. */
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

async function load(filter: string | null = selectedFilter.value) {
  loading.value = true
  error.value = null
  try {
    const result = await loadHome(filter)
    sections.value = result.sections
    filters.value = result.filters
    selectedFilter.value = result.selectedFilter
    hasMore.value = result.hasMore
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!hasMore.value || loading.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const result = await loadMoreHome()
    sections.value = [...sections.value, ...result.sections]
    hasMore.value = result.hasMore
  } catch {
    hasMore.value = false
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

function openAccount() {
  tap()
  void navigate({ name: 'settings-page', page: 'account' })
}

useInfiniteScroll(sentinel, loadMore)
onMounted(() => void load())
watch(sessionVersion, () => void load(null))
</script>

<template>
  <div class="screen home-screen">
    <header class="home-top">
      <button class="search-bar" type="button" @click="navigate({ name: 'search' })">
        <MIcon name="search" />
        <span>Search songs, albums, artists</span>
      </button>
      <button class="avatar-button" type="button" aria-label="Account" @click="openAccount">
        <Thumb v-if="account?.photo" :src="account.photo" :size="36" shape="circle" icon="account" />
        <MIcon v-else name="account" :size="28" />
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
        <MIcon v-if="selectedFilter === filter" name="check" :size="18" />
        {{ filter }}
      </button>
    </div>

    <SectionView v-for="section in localSections" :key="section.id" :section="section" />

    <template v-if="loading && sections.length === 0">
      <div v-for="index in 3" :key="index" class="skeleton-section" aria-hidden="true">
        <span class="skeleton skeleton-title" />
        <div class="skeleton-row">
          <span v-for="card in 4" :key="card" class="skeleton skeleton-card" />
        </div>
      </div>
    </template>

    <StateView
      v-else-if="error && sections.length === 0"
      kind="error"
      title="Couldn't load your home feed"
      :message="error"
      action="Try again"
      @action="load()"
    />

    <div v-else class="home-sections" :class="{ 'is-refreshing': loading }">
      <SectionView v-for="section in sections" :key="section.id" :section="section" />
    </div>

    <div ref="sentinel" class="infinite-sentinel">
      <span v-if="loadingMore" class="loading-indicator small" aria-label="Loading more" />
    </div>
  </div>
</template>
