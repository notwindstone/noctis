<script setup lang="ts">
import { computed, shallowRef, ref, watch } from 'vue'
import { C } from '../plugins/components'
import { tap } from '../haptics'
import { artistNames, type Song } from '../models'
import {
  canonicalOption,
  chosenOption,
  pickOption,
  PLAYBACK_MODES,
  playbackOptions,
  playbackPreference,
  playbackTargets,
  preferenceLabel,
  type PlaybackGroup,
  type PlaybackMode,
  type PlaybackOption,
} from '../playFrom'
import { chooseForAll, chooseForSong, installAndChoose } from '../playFromActions'
import { currentSong, nowPlayingFrom } from '../player'
import { playFromDialog } from '../ui'

/**
 * "Play from", the same dialog from Settings and from the player's menu.
 *
 * Opened for a song, it has two tabs: "This song" (one of the song's options, or follow
 * the preference) and "All songs" (the preference: a mode, or one target), and shows
 * what each would play for this song. From Settings, it's only "All songs". Sources a
 * song doesn't have are greyed out, so a song with one source says so instead of
 * showing a one-item list.
 */

type Scope = 'song' | 'all'

interface Row {
  value: string
  label: string
  description?: string
  /** A second line, e.g. what an "All songs" choice means for this song. */
  detail?: string
  disabled?: boolean
  /** Plays now. */
  playing?: boolean
  option?: PlaybackOption
}

interface Section {
  id: string
  title?: string
  rows: Row[]
}

const song = computed<Song | null>(() => playFromDialog.value?.song ?? null)
const scope = ref<Scope>('song')
const options = shallowRef<PlaybackOption[] | null>(null)

watch(playFromDialog, async (request) => {
  options.value = null
  scope.value = request?.song ? 'song' : 'all'
  if (!request?.song) return
  const list = await playbackOptions(request.song)
  if (playFromDialog.value === request) options.value = list
})

const isCurrent = computed(() => {
  const target = song.value
  const current = currentSong.value
  return Boolean(target && current && target.id === current.id && target.source === current.source)
})

/** A server song with one server source shows that source (with its quality), not also "its best source". */
const shown = (id: string) => (options.value ? canonicalOption(options.value, id) : id)
const visibleOptions = computed(() => options.value?.filter((option) => option.id !== 'default' || shown('default') === 'default') ?? null)

const available = computed(() => visibleOptions.value?.filter((option) => option.available) ?? [])
const labelOf = (id: string) => options.value?.find((option) => option.id === shown(id))?.label ?? id

/** The option that plays the song now (or would, if it isn't playing). */
const picked = computed(() => (song.value && options.value ? shown(pickOption(song.value, options.value)) : null))
const pickedOption = computed(() => options.value?.find((option) => option.id === picked.value) ?? null)

/** Every option is unavailable: say so instead of naming one. */
const nothingPlays = computed(() => Boolean(options.value) && available.value.length === 0)

/** "AAC", "MP3", "OPUS"… from a MIME type; HLS playlists are SoundCloud's AAC. */
function formatName(mimeType: string): string {
  const type = mimeType.toLowerCase()
  if (/mpegurl/.test(type)) return 'HLS'
  if (/opus/.test(type)) return 'OPUS'
  if (/mp4a|audio\/mp4|aac/.test(type)) return 'AAC'
  if (/mpeg|mp3/.test(type)) return 'MP3'
  return type.replace(/^audio\//, '').replace(/;.*$/, '').toUpperCase()
}

/** "OPUS · 160 kbps" for the stream that's playing, else the option's own description. */
const nowQuality = computed(() => {
  const playing = isCurrent.value ? nowPlayingFrom.value : null
  if (playing?.downloaded) return 'Downloaded copy on this device'
  const stream = playing?.stream
  if (stream) {
    const format = formatName(stream.mimeType)
    return [format, stream.bitrate ? `${Math.round(stream.bitrate / 1000)} kbps` : ''].filter(Boolean).join(' · ')
  }
  return pickedOption.value?.description ?? ''
})

const groupTitle: Record<PlaybackGroup, string> = { server: 'From the server', own: 'Yours' }
const groupOf = (option: PlaybackOption): PlaybackGroup => option.group ?? 'own'

function optionRow(option: PlaybackOption): Row {
  const installable = !option.available && Boolean(option.install?.download)
  return {
    value: option.id,
    label: option.label,
    description: installable ? `${option.description ?? 'Needs a plugin'} · tap to install` : option.description,
    disabled: !option.available && !installable,
    playing: option.available && option.id === picked.value,
    option,
  }
}

/** This song: follow the preference, or one of its options; targets it lacks are greyed out. */
const songSections = computed<Section[]>(() => {
  const target = song.value
  const list = visibleOptions.value
  if (!target || !list || !options.value) return []
  const follows = pickOption(target, options.value, playbackPreference.value, null)
  const sections: Section[] = [
    {
      id: 'follow',
      rows: [{ value: '', label: 'Same as other songs', description: `${preferenceLabel()} · here: ${labelOf(follows)}` }],
    },
  ]
  const present = new Set(list.map((option) => option.target).filter(Boolean))
  for (const group of ['server', 'own'] as PlaybackGroup[]) {
    const rows = list.filter((option) => groupOf(option) === group).map(optionRow)
    for (const missing of playbackTargets().filter((item) => item.group === group && !present.has(item.id))) {
      rows.push({ value: `missing:${missing.id}`, label: missing.label, description: missing.available ? 'Not available for this song' : missing.description, disabled: true })
    }
    if (rows.length > 0) sections.push({ id: group, title: groupTitle[group], rows })
  }
  return sections
})

/** All songs: a mode, or always one target (with what that means for this song, if there is one). */
const allSections = computed<Section[]>(() => {
  const target = song.value
  const list = options.value
  const forSong = (preference: string) => (target && list ? `This song: ${labelOf(pickOption(target, list, preference, null))}` : undefined)
  const sections: Section[] = [
    {
      id: 'modes',
      rows: (Object.keys(PLAYBACK_MODES) as PlaybackMode[]).map((mode) => ({
        value: mode,
        label: PLAYBACK_MODES[mode].label,
        description: PLAYBACK_MODES[mode].description,
        detail: forSong(mode),
      })),
    },
  ]
  const targets = playbackTargets()
  for (const group of ['server', 'own'] as PlaybackGroup[]) {
    const rows = targets
      .filter((item) => item.group === group)
      .map((item): Row => {
        const option = list?.find((candidate) => candidate.target === item.id && candidate.available)
        return {
          value: item.id,
          label: item.label,
          description: item.description,
          detail: !target || !list || !item.available ? undefined : option ? `This song: ${option.description || option.label}` : 'Not available for this song, so Automatic',
          disabled: !item.available,
        }
      })
    if (rows.length > 0) sections.push({ id: group, title: `Always ${group === 'server' ? 'from the server' : 'yours'}`, rows })
  }
  return sections
})

const sections = computed(() => (scope.value === 'song' ? songSections.value : allSections.value))

const selected = computed(() => {
  if (scope.value === 'all') return playbackPreference.value
  const target = song.value
  const chosen = target ? chosenOption(target) : null
  return chosen && options.value?.some((option) => option.id === chosen) ? shown(chosen) : ''
})

const hasOwnChoice = computed(() => Boolean(song.value && chosenOption(song.value)))

function setScope(next: Scope) {
  if (scope.value === next) return
  tap()
  scope.value = next
}

function close() {
  playFromDialog.value = null
}

function choose(row: Row) {
  if (row.disabled) return
  const target = song.value
  close()
  if (scope.value === 'all') {
    void chooseForAll(row.value, target)
    return
  }
  if (!target) return
  if (row.option && !row.option.available) installAndChoose(target, row.option)
  else void chooseForSong(target, row.value || null)
}
</script>

<template>
  <C.DialogShell :open="playFromDialog !== null" title="Play from" @close="close">
    <template v-if="song">
      <div class="play-from-switch" role="tablist">
        <button type="button" role="tab" :aria-selected="scope === 'song'" @click="setScope('song')">This song</button>
        <button type="button" role="tab" :aria-selected="scope === 'all'" @click="setScope('all')">All songs</button>
      </div>

      <div class="play-from-now">
        <C.MIcon :name="pickedOption?.group === 'server' ? 'server' : 'device-music'" />
        <span class="choice-text">
          <span class="type-label-medium muted">{{ isCurrent ? 'Playing from' : 'Would play from' }}</span>
          <span class="type-body-large">{{ !options ? 'Looking for sources…' : nothingPlays ? 'Nowhere yet' : (pickedOption?.label ?? 'Its own service') }}</span>
          <span v-if="nowQuality && !nothingPlays" class="type-body-medium muted">{{ nowQuality }}</span>
        </span>
      </div>

      <p v-if="nothingPlays" class="type-body-medium muted dialog-description">
        Nothing here can play "{{ song.title }}". A service that has it (YouTube Music, SoundCloud…) or a copy in your music folders
        would show up here.
      </p>
      <p v-else-if="options && available.length === 1" class="type-body-medium muted dialog-description">
        Only {{ available[0].label }} can play "{{ song.title }}"{{ song.artists.length ? ` by ${artistNames(song.artists)}` : '' }}. More
        sources show up here when your server, plugins or music folders have it.
      </p>
      <p v-else-if="scope === 'all' && hasOwnChoice" class="type-body-medium muted dialog-description">
        This song has its own choice; picking here replaces it.
      </p>
    </template>

    <template v-for="section in sections" :key="section.id">
      <h3 v-if="section.title" class="type-title-small play-from-heading">{{ section.title }}</h3>
      <div class="choice-list" role="radiogroup" :aria-label="section.title">
        <button
          v-for="row in section.rows"
          :key="row.value"
          class="choice-option"
          type="button"
          role="radio"
          :aria-checked="row.value === selected"
          :aria-disabled="row.disabled || undefined"
          :class="{ 'is-unavailable': row.disabled }"
          @click="choose(row)"
        >
          <span class="radio" aria-hidden="true" />
          <span class="choice-text">
            <span class="type-body-large">
              {{ row.label }}
              <span v-if="row.playing && scope === 'song'" class="play-from-badge type-label-small">{{ isCurrent ? 'Playing' : 'Picked' }}</span>
            </span>
            <span v-if="row.description" class="type-body-medium muted">{{ row.description }}</span>
            <span v-if="row.detail" class="type-body-small muted">{{ row.detail }}</span>
          </span>
        </button>
      </div>
    </template>

    <template #actions>
      <button class="text-button" type="button" @click="close">Close</button>
    </template>
  </C.DialogShell>
</template>
