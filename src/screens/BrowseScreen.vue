<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, onMounted } from 'vue'
import StateView from '../components/StateView.vue'
import { useAsync } from '../composables'
import type { Route } from '../navigation'
import { browse } from '../services/api'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const target = computed(() => (props.route.name === 'browse' ? props.route.target : { browseId: '' }))
const fallbackTitle = computed(() => (props.route.name === 'browse' ? (props.route.title ?? '') : ''))

const { data, loading, error, run } = useAsync(() => browse(target.value))
onMounted(run)

const title = computed(() => data.value?.title || fallbackTitle.value)
</script>

<template>
  <div class="screen browse-screen">
    <C.TopAppBar :title="title" back />
    <h1 v-if="title" class="screen-headline type-headline-medium">{{ title }}</h1>
    <StateView v-if="loading && !data" kind="loading" />
    <StateView v-else-if="error && !data" kind="error" title="Couldn't load this page" :message="error" action="Try again" @action="run" />
    <template v-else-if="data">
      <C.SectionView v-for="section in data.sections" :key="section.id" :section="section" />
      <StateView v-if="data.sections.length === 0" title="Nothing to show" />
    </template>
  </div>
</template>
