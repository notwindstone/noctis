<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { describeError, useInfiniteScroll } from '../composables'
import { haptic, tap } from '../haptics'
import { useItemDelegation } from '../itemActions'
import { recordSearch, removeSearch, searchHistory } from '../library'
import { goBack, type Route } from '../navigation'
import type { SearchResult, SearchType, Suggestions } from '../models'
import { search, searchFilters, searchMore, searchSuggestions } from '../services/api'
import { serviceName } from '../services/session'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

/** "All" plus the active service's filters. */
const filters = computed(() => searchFilters())

const input = ref<HTMLInputElement | null>(null)
const sentinel = ref<HTMLElement | null>(null)
const query = ref(props.route.name === 'search' ? (props.route.query ?? '') : '')
const submitted = ref('')
const filter = ref<SearchType>('all')
const editing = ref(true)

const suggestions = ref<Suggestions>({ queries: [], items: [] })
const result = ref<SearchResult | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)

const historyMatches = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return searchHistory.value.filter((item) => !needle || item.toLowerCase().includes(needle)).slice(0, needle ? 3 : 12)
})

/* One delegated handler per list (see src/itemActions.ts). */
const suggestionActions = useItemDelegation(() => ({ items: suggestions.value.items, play: 'radio' }))

/** "All" results are several sections; index them as one flat list. */
const flatResults = computed(() => result.value?.sections.flatMap((section) => section.items) ?? [])
const sectionOffsets = computed(() => {
  let offset = 0
  return (result.value?.sections ?? []).map((section) => {
    const start = offset
    offset += section.items.length
    return start
  })
})

// Mixed results start a radio; a filtered list plays as a list, like a playlist.
const resultActions = useItemDelegation(() =>
  filter.value === 'all'
    ? { items: flatResults.value, play: 'radio' }
    : { items: result.value?.items ?? [], play: 'list', title: `Search • ${submitted.value}` },
)

let suggestTimer = 0
let suggestToken = 0

watch(query, (value) => {
  editing.value = true
  window.clearTimeout(suggestTimer)
  const text = value.trim()
  if (!text) {
    suggestions.value = { queries: [], items: [] }
    return
  }
  suggestTimer = window.setTimeout(async () => {
    const token = ++suggestToken
    try {
      const next = await searchSuggestions(text)
      if (token === suggestToken) suggestions.value = next
    } catch {
      /* suggestions are optional */
    }
  }, 180)
})

async function run(text = query.value) {
  const trimmed = text.trim()
  if (!trimmed) return
  query.value = trimmed
  await nextTick()
  editing.value = false
  submitted.value = trimmed
  input.value?.blur()
  recordSearch(trimmed)

  loading.value = true
  error.value = null
  result.value = null
  try {
    result.value = await search(trimmed, filter.value)
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

function setFilter(next: SearchType) {
  if (filter.value === next) return
  haptic('tick')
  filter.value = next
  void run(submitted.value)
}

function useSuggestion(text: string) {
  tap()
  void run(text)
}

function fillQuery(text: string) {
  query.value = `${text} `
  input.value?.focus()
}

function clear() {
  query.value = ''
  editing.value = true
  input.value?.focus()
}

async function loadMore() {
  if (!result.value?.hasMore || loadingMore.value || editing.value) return
  loadingMore.value = true
  try {
    const more = await searchMore()
    result.value = { ...result.value, items: [...result.value.items, ...more.items], hasMore: more.hasMore }
  } catch {
    result.value = { ...result.value, hasMore: false }
  } finally {
    loadingMore.value = false
  }
}

useInfiniteScroll(sentinel, loadMore)

onMounted(() => {
  if (query.value) void run()
  else window.setTimeout(() => input.value?.focus(), 320)
})
</script>

<template>
  <div class="screen search-screen">
    <header class="search-top">
      <div class="search-field">
        <button class="icon-button" type="button" aria-label="Back" @click="goBack">
          <C.MIcon name="back" />
        </button>
        <input
          ref="input"
          v-model="query"
          type="search"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="`Search ${serviceName}`"
          :aria-label="`Search ${serviceName}`"
          @focus="editing = true"
          @keydown.enter.prevent="run()"
        />
        <button v-if="query" class="icon-button" type="button" aria-label="Clear" @click="clear">
          <C.MIcon name="close" />
        </button>
      </div>

      <div v-if="!editing && submitted" class="chip-row" role="group" aria-label="Filter results">
        <button
          v-for="option in filters"
          :key="option.id"
          class="chip"
          type="button"
          :aria-pressed="filter === option.id"
          @click="setFilter(option.id)"
        >
          <C.MIcon v-if="filter === option.id" name="check" :size="18" />
          {{ option.label }}
        </button>
      </div>
    </header>

    <!-- Suggestions and history while typing -->
    <div v-if="editing" class="suggestions">
      <div v-for="item in historyMatches" :key="`h:${item}`" class="suggestion">
        <button class="suggestion-main" type="button" @click="useSuggestion(item)">
          <C.MIcon name="history" />
          <span class="type-body-large">{{ item }}</span>
        </button>
        <button class="icon-button" type="button" :aria-label="`Remove ${item} from history`" @click="removeSearch(item)">
          <C.MIcon name="close" :size="20" />
        </button>
      </div>
      <div
        v-for="item in suggestions.queries.filter((text) => !historyMatches.includes(text))"
        :key="`q:${item}`"
        class="suggestion"
      >
        <button class="suggestion-main" type="button" @click="useSuggestion(item)">
          <C.MIcon name="search" />
          <span class="type-body-large">{{ item }}</span>
        </button>
        <button class="icon-button" type="button" :aria-label="`Edit ${item}`" @click="fillQuery(item)">
          <C.MIcon name="suggest" :size="20" />
        </button>
      </div>
      <div
        v-if="suggestions.items.length > 0"
        class="suggestion-items"
        @click="suggestionActions.onClick"
        @contextmenu="suggestionActions.onContextmenu"
      >
        <C.ItemRow v-for="(item, index) in suggestions.items" :key="`${item.type}:${item.id}`" :item="item" :index="index" />
      </div>
      <!-- Nothing typed and nothing searched before: say what this is, not a blank page. -->
      <C.StateView
        v-if="!query && historyMatches.length === 0"
        icon="search"
        :title="`Search ${serviceName}`"
        message="Songs, albums, artists and playlists. Your recent searches show up here."
      />
    </div>

    <!-- Results -->
    <template v-else>
      <C.StateView v-if="loading" kind="loading" />
      <C.StateView v-else-if="error" kind="error" title="Search failed" :message="error" action="Try again" @action="run(submitted)" />
      <template v-else-if="result">
        <p v-if="result.correctedQuery" class="corrected type-body-medium">
          Showing results for
          <button type="button" class="link-button" @click="run(result.correctedQuery)">{{ result.correctedQuery }}</button>
        </p>

        <div v-if="filter === 'all'" @click="resultActions.onClick" @contextmenu="resultActions.onContextmenu">
          <section v-for="(section, sectionIndex) in result.sections" :key="section.id" class="result-section">
            <h2 class="type-title-medium result-title">{{ section.title }}</h2>
            <C.ItemRow
              v-for="(item, index) in section.items"
              :key="`${item.type}:${item.id}`"
              :item="item"
              :index="sectionOffsets[sectionIndex] + index"
            />
          </section>
          <C.StateView
            v-if="result.sections.length === 0"
            icon="search"
            title="No results"
            :message="`Nothing on ${serviceName} matches “${submitted}”.`"
          />
        </div>

        <div v-else @click="resultActions.onClick" @contextmenu="resultActions.onContextmenu">
          <C.ItemRow
            v-for="(item, index) in result.items"
            :key="`${item.type}:${item.id}`"
            :item="item"
            :index="index"
          />
          <C.StateView
            v-if="result.items.length === 0"
            icon="search"
            title="No results"
            :message="`Nothing on ${serviceName} matches “${submitted}”.`"
          />
        </div>
      </template>
    </template>

    <div ref="sentinel" class="infinite-sentinel">
      <span v-if="loadingMore" class="loading-indicator small" aria-label="Loading more" />
    </div>
  </div>
</template>
