<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { tap } from '../haptics'
import type { IconName } from '../icons'
import { isLiked, toggleLike } from '../library'
import { navigate } from '../navigation'
import { download, offlineState, removeOffline } from '../offline'
import { addToQueue, playNext, playRadio, playSongs, removeFromQueue, shufflePlay, startRadio } from '../player'
import { notify } from '../snackbar'
import { choiceDialog, closePlayer, confirm, confirmDialog, itemMenu, textDialog } from '../ui'
import { getAlbum, getPlaylist } from '../ytm/api'
import { artistNames, type Item, type Song } from '../ytm/models'
import BottomSheet from './BottomSheet.vue'
import DialogShell from './DialogShell.vue'
import MIcon from './MIcon.vue'
import Thumb from './Thumb.vue'

interface Action {
  icon: IconName
  label: string
  filled?: boolean
  run: () => void | Promise<void>
}

const request = computed(() => itemMenu.value)
const item = computed<Item | null>(() => request.value?.item ?? null)

function close() {
  itemMenu.value = null
}

function go(route: Parameters<typeof navigate>[0]) {
  close()
  closePlayer()
  void navigate(route)
}

async function songsOf(target: Item): Promise<Song[]> {
  if (target.type === 'album') return (await getAlbum(target.id)).songs
  if (target.type === 'playlist') return (await getPlaylist(target.id)).songs
  return []
}

function linkFor(target: Item): string {
  switch (target.type) {
    case 'song':
      return `https://music.youtube.com/watch?v=${target.id}`
    case 'album':
      return `https://music.youtube.com/browse/${target.id}`
    case 'playlist':
      return `https://music.youtube.com/playlist?list=${target.id}`
    case 'artist':
      return `https://music.youtube.com/channel/${target.id}`
  }
}

const actions = computed<Action[]>(() => {
  const target = item.value
  if (!target) return []
  const list: Action[] = []

  if (target.type === 'song') {
    const song = target
    const state = offlineState(song.id)
    const liked = isLiked(song.id)

    if (request.value?.list) {
      const { songs, index, title } = request.value.list
      list.push({ icon: 'play', label: 'Play from here', run: () => playSongs(songs, index, title) })
    }
    list.push(
      { icon: 'play-next', label: 'Play next', run: () => playNext(song) },
      { icon: 'add-queue', label: 'Add to queue', run: () => addToQueue(song) },
      { icon: 'radio', label: 'Start radio', run: () => startRadio(song) },
      {
        icon: 'favorite',
        filled: liked,
        label: liked ? 'Remove from liked songs' : 'Like',
        run: () => toggleLike(song),
      },
    )

    if (state === 'downloaded') {
      list.push({
        icon: 'delete',
        label: 'Remove download',
        run: () =>
          confirm({
            title: 'Remove download?',
            message: `"${song.title}" will no longer be available offline.`,
            confirmLabel: 'Remove',
            destructive: true,
            onConfirm: () => removeOffline(song.id),
          }),
      })
    } else if (state !== 'downloading') {
      list.push({ icon: 'download', label: state === 'cached' ? 'Keep offline' : 'Download', run: () => download(song) })
    }

    if (request.value?.queueIndex !== undefined) {
      const index = request.value.queueIndex
      list.push({ icon: 'close', label: 'Remove from queue', run: () => removeFromQueue(index) })
    }
    if (song.album) {
      const album = song.album
      list.push({ icon: 'album', label: 'Go to album', run: () => go({ name: 'album', id: album.id }) })
    }
    for (const artist of song.artists.filter((ref) => ref.id)) {
      list.push({ icon: 'artist', label: `Go to ${artist.name}`, run: () => go({ name: 'artist', id: artist.id! }) })
    }
  } else if (target.type === 'album' || target.type === 'playlist') {
    if (target.type === 'playlist' && target.radio) {
      list.push({ icon: 'play', label: 'Play', run: () => playRadio(target) })
    } else {
      const title = target.title
      list.push(
        { icon: 'play', label: 'Play', run: async () => playSongs(await songsOf(target), 0, title) },
        { icon: 'shuffle', label: 'Shuffle', run: async () => shufflePlay(await songsOf(target), title) },
        {
          icon: 'add-queue',
          label: 'Add to queue',
          run: async () => {
            const songs = await songsOf(target)
            songs.forEach((song) => addToQueue(song))
          },
        },
        {
          icon: target.type === 'album' ? 'album' : 'playlist',
          label: target.type === 'album' ? 'Go to album' : 'Open playlist',
          run: () => go(target.type === 'album' ? { name: 'album', id: target.id } : { name: 'playlist', id: target.id }),
        },
      )
    }
    if (target.type === 'album') {
      for (const artist of target.artists.filter((ref) => ref.id)) {
        list.push({ icon: 'artist', label: `Go to ${artist.name}`, run: () => go({ name: 'artist', id: artist.id! }) })
      }
    }
  } else if (target.type === 'artist') {
    list.push({ icon: 'artist', label: 'Open artist', run: () => go({ name: 'artist', id: target.id }) })
  }

  list.push({
    icon: 'share',
    label: 'Copy link',
    run: async () => {
      try {
        await navigator.clipboard.writeText(linkFor(target))
        notify('Link copied')
      } catch {
        notify(linkFor(target))
      }
    },
  })

  return list
})

const subtitle = computed(() => {
  const target = item.value
  if (!target) return ''
  if (target.type === 'song') return artistNames(target.artists)
  if (target.type === 'album') return [target.kind ?? 'Album', artistNames(target.artists)].filter(Boolean).join(' • ')
  if (target.type === 'playlist') return target.subtitle ?? 'Playlist'
  return target.subtitle ?? 'Artist'
})

async function run(action: Action) {
  tap()
  close()
  try {
    await action.run()
  } catch {
    notify('Something went wrong. Check your connection.')
  }
}

/* Choice dialog */
function choose(value: string) {
  const dialog = choiceDialog.value
  choiceDialog.value = null
  dialog?.onSelect(value)
}

/* Text dialog */
const text = ref('')
const textBusy = ref(false)
watch(textDialog, () => {
  text.value = ''
  textBusy.value = false
})

async function submitText() {
  const dialog = textDialog.value
  if (!dialog || !text.value.trim()) return
  textBusy.value = true
  try {
    await dialog.onConfirm(text.value)
    textDialog.value = null
  } finally {
    textBusy.value = false
  }
}

/* Confirm dialog */
async function confirmAction() {
  const dialog = confirmDialog.value
  confirmDialog.value = null
  await dialog?.onConfirm()
}
</script>

<template>
  <BottomSheet :open="item !== null" :label="item ? `Options` : undefined" @close="close">
    <template v-if="item">
      <div class="menu-header">
        <Thumb
          :src="item.thumbnail"
          :size="56"
          :shape="item.type === 'artist' ? 'circle' : 'rounded'"
          :icon="item.type === 'artist' ? 'artist' : 'music'"
        />
        <div class="menu-header-text">
          <strong class="type-title-medium">{{ item.type === 'artist' ? item.name : item.title }}</strong>
          <span class="type-body-medium muted">{{ subtitle }}</span>
        </div>
      </div>
      <div class="sheet-scroll">
        <button v-for="action in actions" :key="action.label" class="menu-item" type="button" @click="run(action)">
          <MIcon :name="action.icon" :filled="action.filled" />
          <span class="type-body-large">{{ action.label }}</span>
        </button>
      </div>
    </template>
  </BottomSheet>

  <DialogShell :open="choiceDialog !== null" :title="choiceDialog?.title ?? ''" @close="choiceDialog = null">
    <div class="choice-list" role="radiogroup">
      <button
        v-for="option in choiceDialog?.options ?? []"
        :key="option.value"
        class="choice-option"
        type="button"
        role="radio"
        :aria-checked="option.value === choiceDialog?.value"
        @click="choose(option.value)"
      >
        <span class="radio" aria-hidden="true" />
        <span class="choice-text">
          <span class="type-body-large">{{ option.label }}</span>
          <span v-if="option.description" class="type-body-medium muted">{{ option.description }}</span>
        </span>
      </button>
    </div>
    <template #actions>
      <button class="text-button" type="button" @click="choiceDialog = null">Cancel</button>
    </template>
  </DialogShell>

  <DialogShell :open="textDialog !== null" :title="textDialog?.title ?? ''" @close="textDialog = null">
    <p v-if="textDialog?.description" class="type-body-medium muted dialog-description">{{ textDialog.description }}</p>
    <textarea
      v-if="textDialog?.multiline"
      v-model="text"
      class="text-field"
      rows="5"
      :placeholder="textDialog?.placeholder"
      spellcheck="false"
      autocomplete="off"
    />
    <input
      v-else
      v-model="text"
      class="text-field"
      :placeholder="textDialog?.placeholder"
      autocomplete="off"
      @keydown.enter="submitText"
    />
    <template #actions>
      <button class="text-button" type="button" @click="textDialog = null">Cancel</button>
      <button class="text-button" type="button" :disabled="!text.trim() || textBusy" @click="submitText">
        {{ textDialog?.confirmLabel ?? 'OK' }}
      </button>
    </template>
  </DialogShell>

  <DialogShell :open="confirmDialog !== null" :title="confirmDialog?.title ?? ''" @close="confirmDialog = null">
    <p class="type-body-medium muted dialog-description">{{ confirmDialog?.message }}</p>
    <template #actions>
      <button class="text-button" type="button" @click="confirmDialog = null">Cancel</button>
      <button
        class="text-button"
        :class="{ 'is-destructive': confirmDialog?.destructive }"
        type="button"
        @click="confirmAction"
      >
        {{ confirmDialog?.confirmLabel }}
      </button>
    </template>
  </DialogShell>
</template>
