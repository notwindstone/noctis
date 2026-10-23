<script setup lang="ts">
import { computed } from 'vue'
import { formatTime } from '../format'
import { offlineState } from '../offline'
import { currentSong, isPlaying } from '../player'
import { artistNames, type Item } from '../ytm/models'
import MIcon from './MIcon.vue'
import Thumb from './Thumb.vue'

/**
 * A list row. It has no event listeners: the list around it handles taps and long
 * presses through useItemDelegation (src/itemActions.ts), using `index`.
 */
const props = withDefaults(
  defineProps<{
    item: Item
    /** Position in the list's items, for the delegated handlers. */
    index: number
    /** Show a track number instead of artwork (album pages). */
    number?: number
    /** Overrides the second line. */
    subtitle?: string
    compact?: boolean
  }>(),
  {
    number: undefined,
    subtitle: undefined,
    compact: false,
  },
)

const isCurrent = computed(() => props.item.type === 'song' && currentSong.value?.id === props.item.id)
const offline = computed(() => (props.item.type === 'song' ? offlineState(props.item.id) : 'none'))

const title = computed(() => (props.item.type === 'artist' ? props.item.name : props.item.title))

const secondLine = computed(() => {
  if (props.subtitle !== undefined) return props.subtitle
  const item = props.item
  switch (item.type) {
    case 'song': {
      const parts = [artistNames(item.artists)]
      if (!props.compact && item.album && props.number === undefined) parts.push(item.album.name)
      if (props.number !== undefined && item.duration) parts.push(formatTime(item.duration))
      return parts.filter(Boolean).join(' • ')
    }
    case 'album':
      return [item.kind ?? 'Album', artistNames(item.artists), item.year].filter(Boolean).join(' • ')
    case 'playlist':
      return item.subtitle ?? 'Playlist'
    case 'artist':
      return item.subtitle ?? 'Artist'
  }
  return ''
})
</script>

<template>
  <div class="item-row" :class="{ 'is-current': isCurrent, 'is-compact': compact }" :data-item-index="index">
    <button class="item-row-main" type="button" data-action="open">
      <span v-if="number !== undefined" class="item-row-number type-title-medium">
        <span v-if="isCurrent && isPlaying" class="eq" aria-label="Playing"><span /><span /><span /></span>
        <template v-else>{{ number }}</template>
      </span>
      <span v-else class="item-row-art">
        <Thumb
          :src="item.thumbnail"
          :size="compact ? 48 : 56"
          :shape="item.type === 'artist' ? 'circle' : 'rounded'"
          :icon="item.type === 'artist' ? 'artist' : item.type === 'album' ? 'album' : item.type === 'playlist' ? 'playlist' : 'music'"
        />
        <span v-if="isCurrent" class="item-row-playing" aria-hidden="true">
          <span v-if="isPlaying" class="eq"><span /><span /><span /></span>
          <MIcon v-else name="pause" filled :size="20" />
        </span>
      </span>
      <span class="item-row-text">
        <span class="item-row-title type-body-large">{{ title }}</span>
        <span class="item-row-subtitle type-body-medium">
          <MIcon v-if="item.type === 'song' && item.explicit" class="explicit-badge" name="explicit" filled :size="16" />
          <MIcon v-if="offline === 'downloaded'" class="offline-badge" name="downloaded" :size="16" />
          <MIcon v-else-if="offline === 'downloading'" class="offline-badge" name="downloading" :size="16" />
          <span>{{ secondLine }}</span>
        </span>
      </span>
    </button>
    <button
      v-if="item.type !== 'artist'"
      class="icon-button item-row-more"
      type="button"
      aria-label="More options"
      data-action="menu"
    >
      <MIcon name="more" />
    </button>
  </div>
</template>
