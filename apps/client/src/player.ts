import { computed, ref, shallowRef, watch } from 'vue'
import { artworkHue } from './artColor'
import { haptic } from './haptics'
import { runAfterHooks, runBeforeHooks } from './plugins/hooks'
import { recordPlay } from './library'
import { download, localSource, offline } from './offline'
import { autoplayRelated, cacheEnabled, persistentQueue, previousRestart, repeatMode, shuffleEnabled } from './preferences'
import { writeLog } from './plugins/log'
import { notify } from './snackbar'
import { readJson, writeJson } from './storage'
import { artworkHue as themeArtworkHue } from './theme'
import { queueMore, radio, radioFor, startQueue } from './services/api'
import type { RadioSeed } from './services/types'
import { artistNames, type Playlist, type Song, type StreamInfo } from './models'
import { forgetStream, resolveStream } from './services/stream'
import { thumbnailAt } from './thumbnails'

const audio = new Audio()
audio.preload = 'auto'

export const queue = shallowRef<Song[]>([])
export const currentIndex = ref(-1)
/** Where the queue came from, e.g. "Radio · Song title" or an album name. */
export const queueTitle = ref('')

export const isPlaying = ref(false)
export const isLoading = ref(false)
export const position = ref(0)
export const duration = ref(0)
export const playbackError = ref<string | null>(null)
/** What the current song plays from: its stream (format, bitrate), or a download. For "Play from". */
export const nowPlayingFrom = shallowRef<{ stream: StreamInfo | null; downloaded: boolean } | null>(null)
/** Hue of the current artwork (null for monochrome art), for player colours. */
export const currentHue = ref<number | null>(null)

export const currentSong = computed<Song | null>(() => queue.value[currentIndex.value] ?? null)
export const hasNext = computed(() => currentIndex.value < queue.value.length - 1 || repeatMode.value === 'all')
export const progress = computed(() => (duration.value > 0 ? Math.min(1, position.value / duration.value) : 0))
export const upNext = computed(() => queue.value.slice(currentIndex.value + 1))

/** The order before shuffling, so turning shuffle off restores it. */
let unshuffled: Song[] | null = null
let continuation: { token?: string; playlistId?: string; source?: string } = {}
let fetchingMore = false
let loadToken = 0
let pendingSeek: number | null = null
let retriedExpired = false
/** Times the current song's stream was cut off and loaded again (see the 'ended' handler). */
let cutOffRetries = 0
const MAX_CUT_OFF_RETRIES = 3
/** The stream the current song plays from; null for downloads, local files and nothing loaded. */
let currentStream: StreamInfo | null = null
let pausedAt = 0
let resumeWatch: number | undefined

/**
 * Paused longer than this, resuming fetches a fresh stream: the URL may have expired, the
 * network may have changed (some URLs only work from the address that asked for them),
 * and Android may have dropped the paused element's connection.
 */
const STALE_PAUSE_MS = 10 * 60_000
/** A resume that has no audio to play after this long loads the stream again. */
const RESUME_TIMEOUT_MS = 8000

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function updateMediaSession(song: Song) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  const art = thumbnailAt(song.thumbnail, 512)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: artistNames(song.artists),
    album: song.album?.name ?? '',
    artwork: art ? [{ src: art, sizes: '512x512' }] : [],
  })
}

async function load(index: number, autoplay = true, reload = false) {
  const song = queue.value[index]
  if (!song) return

  if (autoplay && !reload) {
    // Plugins can skip songs (e.g. a filter): "stop" moves on to the next one.
    const outcome = await runBeforeHooks('onPlay', { song, index })
    if (outcome.stopped) {
      if (index < queue.value.length - 1) void load(index + 1, autoplay)
      return
    }
  }

  const token = ++loadToken
  writeLog('noctis', 'info', `Loading "${song.title}" (${index + 1}/${queue.value.length}) from ${song.source ?? 'its service'}${reload ? ' again' : ''}`)
  currentIndex.value = index
  position.value = 0
  duration.value = song.duration ?? 0
  playbackError.value = null
  isLoading.value = true
  retriedExpired = false
  if (!reload) cutOffRetries = 0
  currentStream = null
  nowPlayingFrom.value = null
  pausedAt = Date.now()
  window.clearTimeout(resumeWatch)
  audio.pause()

  updateMediaSession(song)
  if (autoplay && !reload) recordPlay(song)
  void artworkHue(song.thumbnail).then((hue) => {
    if (token === loadToken) {
      currentHue.value = hue
      themeArtworkHue.value = hue
    }
  })
  void maybeFetchMore()
  savePlaybackState()

  // A reload (another "Play from" source) skips downloads: the point is the new source.
  let source = reload ? null : await localSource(song.id)
  let streamed = false

  if (!source) {
    try {
      const stream = await resolveStream(song)
      if (token !== loadToken) return
      source = stream.url
      currentStream = stream
      streamed = true
    } catch (error) {
      if (token !== loadToken) return
      isLoading.value = false
      haptic('reject')
      playbackError.value = (error as Error).message || 'This song could not be played.'
      notify(`Couldn't play "${song.title}": ${playbackError.value}`)
      return
    }
  }

  if (token !== loadToken) return
  audio.src = source
  nowPlayingFrom.value = { stream: currentStream, downloaded: !streamed }

  if (autoplay) {
    try {
      await audio.play()
      if (!reload) runAfterHooks('onPlay', { song, index })
    } catch (error) {
      if (token === loadToken && (error as DOMException).name !== 'AbortError') {
        isLoading.value = false
      }
    }
  } else {
    isLoading.value = false
  }

  if (streamed && cacheEnabled.value && !offline.value[song.id]) {
    // Fill the cache in the background once playback is under way.
    const startCaching = () => {
      if (currentSong.value?.id === song.id) void download(song, 'cache')
    }
    window.setTimeout(startCaching, 4000)
  }
}

/** Keep the queue topped up from the radio/playlist continuation or related songs. */
async function maybeFetchMore() {
  if (fetchingMore || currentIndex.value < queue.value.length - 4) return
  const last = queue.value.at(-1)
  if (!last) return

  fetchingMore = true
  try {
    let songs: Song[] = []
    if (continuation.token) {
      const page = await queueMore(continuation.token, continuation.playlistId, continuation.source)
      continuation = { token: page.continuation, playlistId: page.playlistId, source: continuation.source }
      songs = page.songs
    } else if (autoplayRelated.value && repeatMode.value !== 'all') {
      const page = await radioFor(last)
      continuation = { token: page.continuation, playlistId: page.playlistId, source: last.source }
      songs = page.songs
    }

    const known = new Set(queue.value.map((song) => song.id))
    const fresh = songs.filter((song) => !known.has(song.id))
    if (fresh.length > 0) {
      queue.value = [...queue.value, ...fresh]
      if (unshuffled) unshuffled = [...unshuffled, ...fresh]
      savePlaybackState()
    }
  } catch {
    /* related songs are a bonus; the queue still plays */
  } finally {
    fetchingMore = false
  }
}

/* ------------------------------------------------------------------ *
 * Public controls
 * ------------------------------------------------------------------ */

/**
 * Load the current song again where it is (playing or paused), e.g. after "Play from"
 * picked another source. Doesn't count as another play.
 */
export async function reloadCurrent(play = isPlaying.value) {
  const index = currentIndex.value
  const song = queue.value[index]
  if (!song) return
  const at = audio.src ? audio.currentTime || position.value : position.value
  forgetStream(song.id)
  pendingSeek = at > 0 ? at : null
  await load(index, play, true)
}

/** Whether resuming should fetch a fresh stream instead of trusting the paused one. */
function streamIsStale(): boolean {
  if (!currentStream) return false
  return Date.now() - pausedAt > STALE_PAUSE_MS || currentStream.expiresAt - Date.now() < 60_000
}

/**
 * Resuming a stream that never gets going (a dead connection after a long pause, a URL
 * that stopped working without an error) loads it again where it was.
 */
function watchResume() {
  window.clearTimeout(resumeWatch)
  if (!currentStream) return
  const token = loadToken
  resumeWatch = window.setTimeout(() => {
    if (token !== loadToken || audio.paused || audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
    void reloadCurrent(true)
  }, RESUME_TIMEOUT_MS)
}

function setQueue(
  songs: Song[],
  startIndex: number,
  title: string,
  next: { token?: string; playlistId?: string; source?: string } = {},
) {
  unshuffled = null
  continuation = next
  queueTitle.value = title

  if (shuffleEnabled.value && songs.length > 1) {
    unshuffled = songs
    const first = songs[startIndex]
    const rest = songs.filter((_, index) => index !== startIndex)
    queue.value = [first, ...shuffleArray(rest)]
    void load(0)
  } else {
    queue.value = songs
    void load(startIndex)
  }
}

/** Play a list (album, playlist, search results) starting at one song. */
export function playSongs(songs: Song[], startIndex = 0, title = '') {
  if (songs.length === 0) return
  setQueue(songs, Math.min(Math.max(startIndex, 0), songs.length - 1), title)
}

/**
 * Play one song, followed by its radio. If the song is the one playing, it keeps playing
 * where it is (restarting it would throw away its progress) and only what follows changes.
 */
export async function playSong(song: Song) {
  const current = currentSong.value
  if (current && current.id === song.id && current.source === song.source && audio.src) {
    unshuffled = null
    continuation = {}
    queueTitle.value = `Radio · ${song.title}`
    queue.value = [current]
    currentIndex.value = 0
  } else {
    setQueue([song], 0, `Radio · ${song.title}`)
  }
  const token = loadToken
  try {
    const page = await radioFor(song)
    if (token !== loadToken && currentSong.value?.id !== song.id) return
    const rest = page.songs.filter((item) => item.id !== song.id)
    if (rest.length === 0) {
      notify(`No radio for "${song.title}"`)
      return
    }
    // Whatever the queue held meanwhile (autoplay may have added songs) is replaced by the radio.
    queue.value = [...queue.value.slice(0, currentIndex.value + 1), ...rest]
    continuation = { token: page.continuation, playlistId: page.playlistId, source: song.source }
    savePlaybackState()
  } catch (error) {
    writeLog('noctis', 'warn', `Couldn't start a radio from "${song.title}":`, error)
    notify(`Couldn't start a radio from "${song.title}"`)
  }
}

export const startRadio = playSong

/** Mixes and radios from home rows. */
export async function playRadio(playlist: Playlist) {
  try {
    isLoading.value = true
    const page = await startQueue(
      { playlistId: playlist.id, videoId: playlist.radio?.videoId, params: playlist.radio?.params },
      playlist.source,
    )
    if (page.songs.length === 0) throw new Error('empty')
    setQueue(page.songs, 0, playlist.title, { token: page.continuation, playlistId: page.playlistId, source: playlist.source })
  } catch {
    isLoading.value = false
    notify(`Couldn't start "${playlist.title}"`)
  }
}

/** An opaque queue from a page, e.g. an artist's shuffle or radio. */
export async function playFromQueueSource(options: { playlistId: string; params?: string; title: string; source?: string }) {
  try {
    isLoading.value = true
    const page = await startQueue({ playlistId: options.playlistId, params: options.params }, options.source)
    if (page.songs.length === 0) throw new Error('empty')
    setQueue(page.songs, 0, options.title, { token: page.continuation, playlistId: page.playlistId, source: options.source })
  } catch {
    isLoading.value = false
    notify(`Couldn't play "${options.title}"`)
  }
}

/** A radio from an album or playlist page. */
export async function playRadioFrom(seed: RadioSeed, title: string, source?: string) {
  try {
    isLoading.value = true
    const page = await radio(seed, source)
    if (page.songs.length === 0) throw new Error('empty')
    setQueue(page.songs, 0, title, { token: page.continuation, playlistId: page.playlistId, source })
  } catch {
    isLoading.value = false
    notify(`Couldn't start "${title}"`)
  }
}

export function playNext(song: Song) {
  if (!currentSong.value) return playSongs([song])
  const list = queue.value.filter((item, index) => item.id !== song.id || index === currentIndex.value)
  const current = list.findIndex((item) => item.id === currentSong.value?.id)
  list.splice(current + 1, 0, song)
  queue.value = list
  currentIndex.value = current
  savePlaybackState()
  notify(`"${song.title}" will play next`)
}

export function addToQueue(song: Song) {
  if (!currentSong.value) return playSongs([song])
  if (queue.value.some((item) => item.id === song.id)) {
    notify('Already in the queue')
    return
  }
  queue.value = [...queue.value, song]
  savePlaybackState()
  notify(`Added "${song.title}" to the queue`)
}

export function removeFromQueue(index: number) {
  if (index === currentIndex.value) return
  const list = [...queue.value]
  list.splice(index, 1)
  queue.value = list
  if (index < currentIndex.value) currentIndex.value--
  savePlaybackState()
}

export function moveInQueue(from: number, to: number) {
  if (from === to) return
  const list = [...queue.value]
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  const currentId = currentSong.value?.id
  queue.value = list
  currentIndex.value = list.findIndex((song) => song.id === currentId)
  savePlaybackState()
}

export function jumpTo(index: number) {
  if (index === currentIndex.value) return void togglePlay()
  void load(index)
}

export async function togglePlay() {
  if (!currentSong.value) return

  if (!audio.src) {
    // Restored queue: nothing loaded yet.
    const resumeAt = position.value
    pendingSeek = resumeAt > 0 ? resumeAt : null
    await load(currentIndex.value)
    return
  }

  if (audio.paused) {
    if (streamIsStale()) {
      await reloadCurrent(true)
      return
    }
    watchResume()
    try {
      await audio.play()
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return
      // The paused stream may be gone; a fresh one usually plays.
      if (currentStream) await reloadCurrent(true)
      else notify('Playback could not start.')
    }
  } else {
    audio.pause()
  }
}

export function pause() {
  audio.pause()
}

/** Play if paused (for remote controls, which say "play" rather than "toggle"). */
export async function resume() {
  if (!currentSong.value || (audio.src && !audio.paused)) return
  await togglePlay()
}

/** Bumped on every seek, so the lock screen can resync its progress bar. */
export const seekCount = ref(0)

/** Stop and clear the queue; the mini player disappears. */
export function stopPlayback() {
  loadToken++
  currentStream = null
  nowPlayingFrom.value = null
  window.clearTimeout(resumeWatch)
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  queue.value = []
  currentIndex.value = -1
  queueTitle.value = ''
  unshuffled = null
  continuation = {}
  isPlaying.value = false
  isLoading.value = false
  position.value = 0
  duration.value = 0
  currentHue.value = null
  themeArtworkHue.value = null
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null
  writeJson(STATE_KEY, null)
}

export function next() {
  if (currentIndex.value < queue.value.length - 1) {
    void load(currentIndex.value + 1)
  } else if (repeatMode.value === 'all' && queue.value.length > 0) {
    void load(0)
  }
}

export function previous() {
  // Past the configured point (Settings → Playback) Previous starts the song over.
  const limit = previousRestart.value
  const restarts = limit === 'off' ? false : audio.currentTime > (limit === 'full' ? 1 : Number(limit))
  if (restarts || currentIndex.value <= 0) {
    seek(0)
    return
  }
  void load(currentIndex.value - 1)
}

export function seek(seconds: number) {
  const max = Number.isFinite(audio.duration) ? audio.duration : duration.value
  const target = Math.min(Math.max(seconds, 0), max || 0)
  if (audio.src) audio.currentTime = target
  position.value = target
  seekCount.value++
}

export function seekToRatio(ratio: number) {
  seek(ratio * (duration.value || 0))
}

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function toggleShuffle() {
  shuffleEnabled.value = !shuffleEnabled.value
  const current = currentSong.value
  if (!current) return

  if (shuffleEnabled.value) {
    unshuffled = queue.value
    const before = queue.value.slice(0, currentIndex.value + 1)
    const after = shuffleArray(queue.value.slice(currentIndex.value + 1))
    queue.value = [...before, ...after]
  } else if (unshuffled) {
    queue.value = unshuffled
    currentIndex.value = Math.max(0, unshuffled.findIndex((song) => song.id === current.id))
    unshuffled = null
  }
  savePlaybackState()
}

export function cycleRepeat() {
  repeatMode.value = repeatMode.value === 'off' ? 'all' : repeatMode.value === 'all' ? 'one' : 'off'
}

/** Play an entire list shuffled. */
export function shufflePlay(songs: Song[], title = '') {
  if (songs.length === 0) return
  const start = Math.floor(Math.random() * songs.length)
  if (!shuffleEnabled.value) toggleShuffle()
  setQueue(songs, start, title)
}

/* ------------------------------------------------------------------ *
 * Audio element events
 * ------------------------------------------------------------------ */

audio.addEventListener('timeupdate', () => {
  position.value = audio.currentTime
})

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) duration.value = audio.duration
  if (pendingSeek !== null) {
    audio.currentTime = Math.min(pendingSeek, audio.duration || pendingSeek)
    pendingSeek = null
  }
})

audio.addEventListener('playing', () => {
  isLoading.value = false
  isPlaying.value = true
  // It plays again: a later expiry deserves its own retry.
  retriedExpired = false
  window.clearTimeout(resumeWatch)
})
audio.addEventListener('play', () => {
  isPlaying.value = true
})
audio.addEventListener('pause', () => {
  isPlaying.value = false
  pausedAt = Date.now()
  savePlaybackState()
})
audio.addEventListener('waiting', () => {
  isLoading.value = true
})
audio.addEventListener('canplay', () => {
  isLoading.value = false
})

audio.addEventListener('ended', () => {
  // A stream that stops well before its own length was cut off by the server (a dropped or
  // throttled connection looks like a clean end to the player). Don't treat it as the song
  // being over: load the stream again from where it stopped, a few times at most.
  const song = currentSong.value
  const length = audio.duration
  if (song && currentStream && Number.isFinite(length) && length > 0 && audio.currentTime < length - 3) {
    writeLog('noctis', 'warn', `"${song.title}" ended at ${Math.round(audio.currentTime)}s of ${Math.round(length)}s${cutOffRetries < MAX_CUT_OFF_RETRIES ? '; loading it again' : ''}`)
    if (cutOffRetries < MAX_CUT_OFF_RETRIES) {
      cutOffRetries++
      void reloadCurrent(true)
      return
    }
  }
  if (repeatMode.value === 'one') return
  if (currentIndex.value < queue.value.length - 1 || repeatMode.value === 'all') {
    next()
  } else {
    isPlaying.value = false
  }
})

audio.addEventListener('error', () => {
  const song = currentSong.value
  if (!song || !audio.src) return

  // Stream URLs expire after a few hours; get a fresh one once and resume.
  if (!retriedExpired && !audio.src.startsWith('blob:') && !audio.src.includes('_capacitor_file_')) {
    retriedExpired = true
    forgetStream(song.id)
    const resumeAt = audio.currentTime
    void resolveStream(song)
      .then((stream) => {
        if (currentSong.value?.id !== song.id) return
        pendingSeek = resumeAt
        currentStream = stream
        nowPlayingFrom.value = { stream, downloaded: false }
        audio.src = stream.url
        return audio.play()
      })
      .catch(() => {
        isLoading.value = false
        playbackError.value = 'The stream was refused.'
        notify(`Couldn't play "${song.title}".`)
      })
    return
  }

  isLoading.value = false
  playbackError.value = 'The stream was refused.'
  notify(`Couldn't play "${song.title}".`)
})

watch(repeatMode, (mode) => {
  audio.loop = mode === 'one'
})

/* ------------------------------------------------------------------ *
 * Persistence and media session
 * ------------------------------------------------------------------ */

interface SavedPlayback {
  queue: Song[]
  index: number
  position: number
  title: string
}

const STATE_KEY = 'noctis:playback'
let lastSave = 0

function savePlaybackState() {
  if (!persistentQueue.value) return
  lastSave = Date.now()
  writeJson(STATE_KEY, {
    queue: queue.value.slice(0, 500),
    index: currentIndex.value,
    position: position.value,
    title: queueTitle.value,
  } satisfies SavedPlayback)
}

watch(position, () => {
  if (Date.now() - lastSave > 5000) savePlaybackState()
})

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void togglePlay()],
    ['pause', () => audio.pause()],
    ['previoustrack', () => previous()],
    ['nexttrack', () => next()],
    ['seekto', (details) => seek(details.seekTime ?? 0)],
  ]
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      /* unsupported action on this platform */
    }
  }
}

let initialized = false

export function initPlayer() {
  if (initialized) return
  initialized = true
  audio.loop = repeatMode.value === 'one'
  setupMediaSession()

  if (!persistentQueue.value) return
  const saved = readJson<SavedPlayback | null>(STATE_KEY, null)
  if (!saved || !Array.isArray(saved.queue) || saved.queue.length === 0) return

  queue.value = saved.queue
  currentIndex.value = Math.min(Math.max(saved.index, 0), saved.queue.length - 1)
  queueTitle.value = saved.title ?? ''
  position.value = saved.position ?? 0
  const song = currentSong.value
  if (song) {
    duration.value = song.duration ?? 0
    updateMediaSession(song)
    void artworkHue(song.thumbnail).then((hue) => {
      currentHue.value = hue
      themeArtworkHue.value = hue
    })
  }
}
