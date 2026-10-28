import type { ActionEntry, PluginScope, Song } from './host'

/**
 * Offline wave: pre-generate a batch of songs around what you're listening to and
 * download them all, so a trip doesn't depend on a connection.
 *
 * The wave starts with the songs already up next, then follows a radio from the
 * current song (or from your likes and history when nothing is playing) until it
 * reaches the configured size. Songs already downloaded are skipped, so running it
 * again finds new ones. Downloads go through the app's normal offline pipeline
 * (`Noctis.libs.offline.download`), which also means they show up under Downloads.
 */

const SECTION = { id: 'offline-wave', icon: 'downloaded', title: 'Offline wave', description: 'Download a batch of songs before you travel' }

const SIZES = [25, 50, 100, 200, 500]
const CONCURRENCIES = [1, 2, 3, 4]
/** Radios page in ~20–25 songs; this keeps a bad continuation from looping forever. */
const MAX_RADIO_PAGES = 20

type Phase = 'idle' | 'generating' | 'downloading' | 'done' | 'error'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function offlineWave({ Plugin, Noctis }: PluginScope) {
  const { computed, reactive, ref } = Noctis.packages.vue
  const { library, navigation, offline, player, snackbar, ui } = Noctis.libs

  function storedChoice(key: string, fallback: number, choices: number[]): number {
    const value = Plugin.storage.get<number>(key, fallback)
    return typeof value === 'number' && choices.includes(value) ? value : fallback
  }

  const count = ref(storedChoice('count', 100, SIZES))
  const concurrency = ref(storedChoice('concurrency', 2, CONCURRENCIES))
  const includeQueue = ref(Plugin.storage.get<boolean>('includeQueue', true) ?? true)
  const ask = ref(Plugin.storage.get<boolean>('ask', true) ?? true)

  const state = reactive({
    phase: 'idle' as Phase,
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    current: '',
    error: '',
    cancelled: false,
  })

  const running = computed(() => state.phase === 'generating' || state.phase === 'downloading')

  /* ------------------------------------------------------------------ *
   * Building the wave
   * ------------------------------------------------------------------ */

  async function buildWave(seed?: Song): Promise<Song[]> {
    const target = count.value
    const picked: Song[] = []
    const seen = new Set<string>()
    let skipped = 0

    const offer = (songs: readonly Song[] | null | undefined) => {
      for (const song of songs ?? []) {
        if (picked.length >= target) return
        if (!song || song.type !== 'song' || !song.id) continue
        if (seen.has(song.id)) continue
        seen.add(song.id)
        if (offline.offlineState(song.id) === 'downloaded') {
          skipped += 1
          continue
        }
        picked.push(song)
      }
    }

    const growFromRadio = async (seedSong: Song) => {
      let page
      try {
        page = await Noctis.api.radio({ kind: 'song', song: seedSong })
      } catch (error) {
        Plugin.log(`No radio for "${seedSong.title}": ${messageOf(error)}`)
        return
      }
      if (!page || picked.length >= target) return
      offer(page.songs)

      let continuation = page.continuation
      let playlistId = page.playlistId
      for (let pages = 0; picked.length < target && continuation && pages < MAX_RADIO_PAGES; pages++) {
        try {
          const more = await Noctis.api.queueMore(continuation, playlistId, seedSong.source)
          offer(more.songs)
          if (!more.continuation || more.continuation === continuation || more.songs.length === 0) break
          continuation = more.continuation
          playlistId = more.playlistId ?? playlistId
        } catch (error) {
          Plugin.log(`Couldn't extend the radio for "${seedSong.title}": ${messageOf(error)}`)
          break
        }
      }
    }

    // Up next first: these are the songs the listener is most likely to want on the trip.
    if (includeQueue.value) {
      const queue = player.queue.value
      const start = Math.max(0, player.currentIndex.value)
      offer(queue.slice(start))
      if (picked.length < target) offer(queue.slice(0, start))
    }

    const seeds: Song[] = []
    if (seed) seeds.push(seed)
    if (player.currentSong.value) seeds.push(player.currentSong.value)
    if (picked.length > 0) seeds.push(picked[picked.length - 1])
    seeds.push(...library.likedSongs.value.slice(0, 3))
    seeds.push(...library.history.value.slice(0, 3).map((entry) => entry.song))

    const tried = new Set<string>()
    for (const seedSong of seeds) {
      if (picked.length >= target) break
      if (!seedSong || tried.has(seedSong.id)) continue
      tried.add(seedSong.id)
      await growFromRadio(seedSong)
    }

    // Services without radios (or an empty one) can still fill the wave from what's here.
    if (picked.length < target) {
      offer(library.likedSongs.value)
      offer(library.history.value.map((entry) => entry.song))
    }

    if (picked.length < target) {
      try {
        const home = await Noctis.api.loadHome()
        for (const section of home.sections) {
          offer(section.items.filter((item): item is Song => item.type === 'song'))
          if (picked.length >= target) break
        }
      } catch (error) {
        Plugin.log(`Couldn't read the home feed for more songs: ${messageOf(error)}`)
      }
    }

    state.skipped = skipped
    return picked
  }

  /* ------------------------------------------------------------------ *
   * Downloading
   * ------------------------------------------------------------------ */

  async function downloadSongs(songs: Song[]) {
    state.phase = 'downloading'
    state.total = songs.length
    state.done = 0
    state.failed = 0

    let next = 0
    const worker = async () => {
      for (;;) {
        if (state.cancelled) return
        const index = next++
        if (index >= songs.length) return
        const song = songs[index]
        state.current = song.title
        try {
          await offline.download(song, 'download')
          if (offline.offlineState(song.id) === 'downloaded') state.done += 1
          else state.failed += 1
        } catch (error) {
          state.failed += 1
          Plugin.warn(`Couldn't download "${song.title}": ${messageOf(error)}`)
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency.value, songs.length) }, worker)
    await Promise.all(workers)
    state.current = ''
  }

  async function runWave(seed?: Song) {
    state.phase = 'generating'
    state.cancelled = false
    state.total = 0
    state.done = 0
    state.failed = 0
    state.skipped = 0
    state.current = ''
    state.error = ''

    try {
      Plugin.log(`Building a wave of up to ${count.value} songs${seed ? ` from "${seed.title}"` : ''}`)
      const songs = await buildWave(seed)
      if (state.cancelled) {
        state.phase = 'done'
        snackbar.notify('Wave cancelled')
        return
      }
      if (songs.length === 0) {
        state.phase = 'done'
        snackbar.notify('Nothing new to add: this wave is already downloaded.')
        return
      }

      snackbar.notify(`Downloading ${songs.length} songs for offline listening`)
      await downloadSongs(songs)

      state.phase = 'done'
      if (state.cancelled) snackbar.notify(`Wave stopped: ${state.done} of ${songs.length} songs downloaded`)
      else if (state.failed > 0) snackbar.notify(`Wave finished: ${state.done} downloaded, ${state.failed} failed`)
      else snackbar.notify(`${state.done} songs are ready offline`)
    } catch (error) {
      state.phase = 'error'
      state.error = messageOf(error)
      Plugin.error('Could not build the wave:', error)
      snackbar.notify(`Couldn't build the wave: ${state.error}`)
    }
  }

  function startWave(seed?: Song): void | false {
    if (running.value) {
      snackbar.notify('A wave is already downloading')
      return false
    }

    const begin = () => void runWave(seed)
    if (ask.value) {
      ui.confirm({
        title: 'Download a wave?',
        message: `${seed ? `Starting from "${seed.title}", up to` : 'Up to'} ${count.value} songs will be generated and downloaded. This can use a lot of mobile data.`,
        confirmLabel: 'Download',
        onConfirm: begin,
      })
    } else {
      begin()
    }
  }

  function stopWave() {
    if (!running.value) return
    state.cancelled = true
    snackbar.notify('Stopping after the songs already downloading')
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  const playerEntry: ActionEntry<{ song: Song }> = {
    id: 'offline-wave',
    icon: () => (running.value ? 'downloading' : 'downloaded'),
    label: () => {
      if (state.phase === 'generating') return 'Building wave…'
      if (state.phase === 'downloading') return `Wave ${state.done + state.failed}/${state.total}`
      return `Keep ${count.value} offline`
    },
    action: 'offline-wave.start',
    progress: () => (running.value ? (state.total > 0 ? (state.done + state.failed) / state.total : 0.05) : undefined),
  }

  const songEntry: ActionEntry<{ item: Song }> = {
    id: 'offline-wave',
    icon: 'downloaded',
    label: 'Download an offline wave',
    action: 'offline-wave.startFrom',
    visible: () => !running.value,
  }

  function removeEntry(entries: ActionEntry[], entry: ActionEntry) {
    const index = entries.indexOf(entry)
    if (index !== -1) entries.splice(index, 1)
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  function statusValue(): string {
    switch (state.phase) {
      case 'generating':
        return 'Finding songs…'
      case 'downloading':
        return `${state.done + state.failed} of ${state.total}`
      case 'done':
        return state.done === 0 && state.total === 0 ? 'Nothing new' : `${state.done} downloaded${state.failed > 0 ? `, ${state.failed} failed` : ''}`
      case 'error':
        return 'Failed'
      default:
        return 'Idle'
    }
  }

  function statusDescription(): string {
    switch (state.phase) {
      case 'generating':
        return 'Building a wave from your queue, likes and radio'
      case 'downloading':
        return state.current ? `Now: ${state.current}` : 'Getting ready…'
      case 'error':
        return state.error
      case 'done': {
        const parts: string[] = []
        if (state.skipped > 0) parts.push(`${state.skipped} already offline`)
        if (state.failed > 0) parts.push(`${state.failed} failed`)
        if (state.cancelled) parts.push('stopped')
        return parts.length > 0 ? parts.join(' · ') : state.done > 0 ? 'Ready for the road' : 'Nothing new to download'
      }
      default:
        return ''
    }
  }

  function defineSettings() {
    Plugin.defineSection(SECTION, [
      Noctis.group('wave', [
        {
          id: 'count',
          icon: 'playlist-add',
          title: 'Songs per wave',
          get disabled() {
            return running.value
          },
          get value() {
            return `${count.value} songs`
          },
          select: {
            title: 'Songs per wave',
            options: SIZES.map((size) => ({ value: String(size), label: `${size} songs` })),
            get value() {
              return String(count.value)
            },
            set(value) {
              count.value = Number(value)
              Plugin.storage.set('count', count.value)
            },
          },
        },
        {
          id: 'include-queue',
          icon: 'queue',
          title: "Include what's up next",
          description: 'Start with the songs already in your queue before generating more',
          get disabled() {
            return running.value
          },
          toggle: {
            get value() {
              return includeQueue.value
            },
            set(value) {
              includeQueue.value = value
              Plugin.storage.set('includeQueue', value)
            },
          },
        },
        {
          id: 'concurrency',
          icon: 'bolt',
          title: 'Downloads at once',
          description: 'Lower this on a slow connection',
          get disabled() {
            return running.value
          },
          select: {
            title: 'Downloads at once',
            options: CONCURRENCIES.map((value) => ({ value: String(value), label: value === 1 ? 'One at a time' : `${value} at a time` })),
            get value() {
              return String(concurrency.value)
            },
            set(value) {
              concurrency.value = Number(value)
              Plugin.storage.set('concurrency', concurrency.value)
            },
          },
        },
        {
          id: 'ask',
          icon: 'warning',
          title: 'Ask before downloading',
          description: 'Show how many songs will be downloaded first',
          toggle: {
            get value() {
              return ask.value
            },
            set(value) {
              ask.value = value
              Plugin.storage.set('ask', value)
            },
          },
        },
        {
          id: 'start',
          icon: 'downloaded',
          title: 'Download a wave now',
          get description() {
            if (running.value) return statusDescription()
            const song = player.currentSong.value
            return song ? `Starts from "${song.title}"` : 'Starts from your likes and history'
          },
          get disabled() {
            return running.value
          },
          onClick: () => void startWave(),
        },
        {
          id: 'stop',
          icon: 'close',
          title: 'Stop this wave',
          destructive: true,
          get hidden() {
            return !running.value
          },
          onClick: stopWave,
        },
        {
          id: 'downloads',
          icon: 'library',
          title: 'View downloaded songs',
          chevron: true,
          onClick: () => void navigation.navigate({ name: 'collection', id: 'downloads' }),
        },
      ]),
      Noctis.group('progress', [
        {
          id: 'status',
          icon: 'downloading',
          title: 'Wave progress',
          get hidden() {
            return state.phase === 'idle'
          },
          get value() {
            return statusValue()
          },
          get description() {
            return statusDescription()
          },
        },
      ]),
      {
        id: 'note',
        type: 'note',
        text: 'A wave starts from the song that is playing (and your queue), then follows its radio until it reaches the amount. Songs already downloaded are skipped. Downloads are kept in Library → Downloads and work without a connection.',
      },
    ])
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function attach() {
    Plugin.registerAction<{ song?: Song }>('offline-wave.start', ({ song }) => {
      if (startWave(song) === false) return false
    })
    Plugin.registerAction<{ item: Song }>('offline-wave.startFrom', ({ item }) => {
      if (startWave(item) === false) return false
    })
    Noctis.ActionCollections.playerActions.push(playerEntry as ActionEntry)
    Noctis.ActionCollections.songMenu.push(songEntry as ActionEntry)
    defineSettings()
  }

  function detach() {
    state.cancelled = true
    Plugin.unregisterAction('offline-wave.start')
    Plugin.unregisterAction('offline-wave.startFrom')
    removeEntry(Noctis.ActionCollections.playerActions, playerEntry as ActionEntry)
    removeEntry(Noctis.ActionCollections.songMenu, songEntry as ActionEntry)
    Plugin.removeSection(SECTION.id)
  }

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  Plugin.log('Offline wave is ready. Set the wave size in Settings → Offline wave.')
}
