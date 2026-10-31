<script setup lang="ts">
import { C } from '../plugins/components'
import { computed } from 'vue'
import { currentSong, isPlaying } from '../player'
import { artistNames, type Item } from '../models'

/** A card; taps and long presses are handled by the list around it (src/itemActions.ts). */
const props = withDefaults(defineProps<{ item: Item; index: number; width?: number; fluid?: boolean; subtitle?: string; hideSubtitle?: boolean; number?: number }>(), { width: 148, fluid: false, subtitle: undefined, hideSubtitle: false, number: undefined })

const title = computed(() => (props.item.type === 'artist' ? props.item.name : props.item.title))
const isCurrent = computed(() => props.item.type === 'song' && currentSong.value?.id === props.item.id)

const text = computed(() => {
  if (props.hideSubtitle) return ''
  if (props.subtitle !== undefined) return props.subtitle
  const item = props.item
  switch (item.type) {
    case 'song':
      return artistNames(item.artists)
    case 'album':
      return [item.kind, item.year ?? artistNames(item.artists)].filter(Boolean).join(' • ')
    case 'playlist':
      return item.subtitle ?? ''
    case 'artist':
      return item.subtitle ?? ''
  }
  return ''
})

</script>

<template>
  <button
    class="item-card"
    :class="{ 'is-artist': item.type === 'artist' }"
    :style="fluid ? undefined : { width: `${width}px` }"
    type="button"
    data-action="open"
    :data-item-index="index"
  >
    <span class="item-card-art">
      <C.Thumb
        :src="item.thumbnail"
        :size="width"
        :shape="item.type === 'artist' ? 'circle' : 'rounded'"
        :icon="item.type === 'artist' ? 'artist' : item.type === 'album' ? 'album' : item.type === 'playlist' ? 'playlist' : 'music'"
      />
      <span v-if="number !== undefined && !isCurrent" class="item-card-number type-label-medium" aria-hidden="true">{{ number }}</span>
      <span v-if="isCurrent" class="item-card-playing" aria-hidden="true">
        <C.PlayingBars v-if="isPlaying" />
        <C.MIcon v-else name="pause" filled :size="22" />
      </span>
      <span v-else-if="item.type === 'playlist' && item.radio" class="item-card-badge" aria-hidden="true">
        <C.MIcon name="play" filled :size="20" />
      </span>
    </span>
    <span class="item-card-title type-title-small">{{ title }}</span>
    <span v-if="text" class="item-card-subtitle type-body-small">{{ text }}</span>
  </button>
</template>
