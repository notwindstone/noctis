<script setup lang="ts">
import { computed } from 'vue'
import { currentSong, isPlaying } from '../player'
import { artistNames, type Item } from '../models'
import MIcon from './MIcon.vue'
import Thumb from './Thumb.vue'

/** A card; taps and long presses are handled by the list around it (src/itemActions.ts). */
const props = withDefaults(defineProps<{ item: Item; index: number; width?: number }>(), { width: 148 })

const title = computed(() => (props.item.type === 'artist' ? props.item.name : props.item.title))
const isCurrent = computed(() => props.item.type === 'song' && currentSong.value?.id === props.item.id)

const subtitle = computed(() => {
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
    :style="{ width: `${width}px` }"
    type="button"
    data-action="open"
    :data-item-index="index"
  >
    <span class="item-card-art">
      <Thumb
        :src="item.thumbnail"
        :size="width"
        :shape="item.type === 'artist' ? 'circle' : 'rounded'"
        :icon="item.type === 'artist' ? 'artist' : item.type === 'album' ? 'album' : item.type === 'playlist' ? 'playlist' : 'music'"
      />
      <span v-if="isCurrent" class="item-card-playing" aria-hidden="true">
        <span v-if="isPlaying" class="eq"><span /><span /><span /></span>
        <MIcon v-else name="pause" filled :size="22" />
      </span>
      <span v-else-if="item.type === 'playlist' && item.radio" class="item-card-badge" aria-hidden="true">
        <MIcon name="play" filled :size="20" />
      </span>
    </span>
    <span class="item-card-title type-title-small">{{ title }}</span>
    <span v-if="subtitle" class="item-card-subtitle type-body-small">{{ subtitle }}</span>
  </button>
</template>
