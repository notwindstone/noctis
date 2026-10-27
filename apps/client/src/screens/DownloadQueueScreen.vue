<script setup lang="ts">
import { computed } from 'vue'
import { C } from '../plugins/components'
import { artistNames, type Song } from '../models'
import {
  batch,
  batchPosition,
  cancelDownload,
  cancelDownloads,
  clearFailures,
  download,
  failures,
  nowRunning,
  transfers,
  waiting,
} from '../offline'
import type { Route } from '../navigation'

defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()

const running = computed(() => [...nowRunning.values()])
const busy = computed(() => running.value.length > 0 || waiting.value.length > 0)

const progressOf = (song: Song) => transfers.get(song.id)?.progress ?? 0

const summary = computed(() => {
  if (batch.active) return `${batchPosition.value}${batch.failed ? ` · ${batch.failed} failed` : ''}`
  if (batch.finished) {
    const songs = `${batch.done} ${batch.done === 1 ? 'song' : 'songs'}`
    return batch.failed ? `Downloaded ${songs}, ${batch.failed} failed` : `Downloaded ${songs}`
  }
  return ''
})
</script>

<template>
  <div class="screen">
    <C.TopAppBar title="Downloading" back :reveal-at="48" />
    <h1 class="screen-headline type-headline-medium">Downloading</h1>

    <p v-if="summary" class="downloads-summary type-body-large">{{ summary }}</p>
    <div v-if="busy" class="downloads-actions">
      <button class="downloads-button type-label-large" type="button" @click="cancelDownloads">
        <C.MIcon name="close" :size="20" />
        Cancel all
      </button>
    </div>

    <template v-if="running.length > 0">
      <h2 class="downloads-heading type-title-small">Downloading now</h2>
      <div class="downloads-list">
        <div v-for="song in running" :key="song.id" class="item-row downloads-row">
          <span class="item-row-art"><C.Thumb :src="song.thumbnail" :size="52" shape="rounded" icon="music" /></span>
          <span class="item-row-text">
            <span class="item-row-title type-body-large">{{ song.title }}</span>
            <span class="item-row-subtitle type-body-medium"><span>{{ artistNames(song.artists) }}</span></span>
            <span class="downloads-bar"><span :style="{ width: `${progressOf(song) * 100}%` }" /></span>
          </span>
          <button class="icon-button" type="button" :aria-label="`Cancel ${song.title}`" @click="cancelDownload(song.id)">
            <C.MIcon name="close" />
          </button>
        </div>
      </div>
    </template>

    <template v-if="waiting.length > 0">
      <h2 class="downloads-heading type-title-small">Waiting · {{ waiting.length }}</h2>
      <div class="downloads-list">
        <div v-for="song in waiting" :key="song.id" class="item-row downloads-row">
          <span class="item-row-art"><C.Thumb :src="song.thumbnail" :size="52" shape="rounded" icon="music" /></span>
          <span class="item-row-text">
            <span class="item-row-title type-body-large">{{ song.title }}</span>
            <span class="item-row-subtitle type-body-medium"><span>{{ artistNames(song.artists) }}</span></span>
          </span>
          <button class="icon-button" type="button" :aria-label="`Remove ${song.title} from the queue`" @click="cancelDownload(song.id)">
            <C.MIcon name="close" />
          </button>
        </div>
      </div>
    </template>

    <template v-if="failures.length > 0">
      <h2 class="downloads-heading type-title-small">
        Failed · {{ failures.length }}
        <button class="downloads-link type-label-large" type="button" @click="clearFailures">Clear</button>
      </h2>
      <div class="downloads-list">
        <div v-for="{ song, message } in failures" :key="song.id" class="item-row downloads-row">
          <span class="item-row-art"><C.Thumb :src="song.thumbnail" :size="52" shape="rounded" icon="music" /></span>
          <span class="item-row-text">
            <span class="item-row-title type-body-large">{{ song.title }}</span>
            <span class="item-row-subtitle type-body-medium"><span>{{ message }}</span></span>
          </span>
          <button class="icon-button" type="button" :aria-label="`Retry ${song.title}`" @click="download(song)">
            <C.MIcon name="refresh" />
          </button>
        </div>
      </div>
    </template>

    <C.StateView
      v-if="!busy && failures.length === 0"
      icon="downloaded"
      title="Nothing downloading"
      message="Songs you download show up here while they wait and transfer."
    />
  </div>
</template>
