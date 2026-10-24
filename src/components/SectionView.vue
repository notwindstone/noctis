<script setup lang="ts">
import { C } from '../plugins/components'
import { computed } from 'vue'
import { useItemDelegation } from '../itemActions'
import { openBrowse } from '../navigation'
import type { Section, Song } from '../models'
import MIcon from './MIcon.vue'
import Thumb from './Thumb.vue'

const props = defineProps<{ section: Section }>()

const songs = computed(() => props.section.items.filter((item): item is Song => item.type === 'song'))

/** Quick picks: songs in pages of four rows that scroll sideways, as in YouTube Music. */
const columns = computed(() => {
  const result: Song[][] = []
  for (let i = 0; i < songs.value.length; i += 4) result.push(songs.value.slice(i, i + 4))
  return result
})

// Home rows start a radio from the tapped song, like YouTube Music.
const { onClick, onContextmenu } = useItemDelegation(() => ({
  items: props.section.layout === 'quick-picks' ? songs.value : props.section.items,
  play: 'radio',
  title: props.section.title,
}))

function more() {
  if (props.section.more) void openBrowse(props.section.more, props.section.title)
}
</script>

<template>
  <section class="home-section" @click="onClick" @contextmenu="onContextmenu">
    <header v-if="section.title" class="section-header">
      <Thumb
        v-if="section.thumbnail"
        class="section-header-thumb"
        :src="section.thumbnail"
        :size="44"
        :shape="section.thumbnailRound ? 'circle' : 'rounded'"
      />
      <button class="section-header-text" type="button" :disabled="!section.more" @click="more">
        <span v-if="section.strapline" class="section-strapline type-label-medium">{{ section.strapline }}</span>
        <span class="section-title type-title-large">{{ section.title }}</span>
      </button>
      <button v-if="section.more" class="icon-button" type="button" :aria-label="`More ${section.title}`" @click="more">
        <MIcon name="chevron-right" />
      </button>
    </header>

    <div v-if="section.layout === 'quick-picks'" class="quick-picks">
      <div v-for="(column, columnIndex) in columns" :key="columnIndex" class="quick-picks-column">
        <C.ItemRow v-for="(song, row) in column" :key="song.id" :item="song" :index="columnIndex * 4 + row" compact />
      </div>
    </div>

    <div v-else-if="section.layout === 'carousel'" class="carousel">
      <C.ItemCard v-for="(item, index) in section.items" :key="`${item.type}:${item.id}`" :item="item" :index="index" />
    </div>

    <div v-else class="section-list">
      <C.ItemRow
        v-for="(item, index) in section.items"
        :key="`${item.type}:${item.id}`"
        :item="item"
        :index="index"
      />
    </div>
  </section>
</template>
