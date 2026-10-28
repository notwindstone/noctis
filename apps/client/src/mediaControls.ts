import { watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { hasNoctisPlugin, isDesktop, Noctis, type MediaState } from './native'
import { writeLog } from './plugins/log'
import { notify } from './snackbar'
import {
  currentIndex,
  currentSong,
  duration,
  hasNext,
  isLoading,
  isPlaying,
  next,
  pause,
  position,
  previous,
  resume,
  seek,
  seekCount,
  stopPlayback,
  togglePlay,
} from './player'
import { keepAwake, mediaControls } from './preferences'
import { artistNames } from './models'
import { thumbnailAt } from './thumbnails'

/**
 * Mirrors the player into Android's media session: the notification and the lock screen
 * show the song, a progress bar and prev / play-pause / next, and drive the player back.
 * The foreground service behind it also keeps playback alive in the background.
 *
 * The session only starts once something has actually played, so a restored queue
 * doesn't put a notification up on launch.
 *
 * While music plays (or is loading to play), a CPU and Wi-Fi wake lock keeps a phone
 * with the screen off from sleeping between buffer refills (`keepAwake`).
 */

let started = false

function state(): MediaState | null {
  const song = currentSong.value
  if (!song) return null
  return {
    title: song.title,
    artist: artistNames(song.artists),
    album: song.album?.name ?? '',
    artwork: thumbnailAt(song.thumbnail, 512),
    duration: duration.value,
    position: position.value,
    playing: isPlaying.value,
    hasPrevious: true,
    hasNext: hasNext.value,
  }
}

function sync() {
  if (!mediaControls.value) return
  const current = state()
  if (!current) {
    if (started) {
      started = false
      void Noctis.clearMediaSession().catch(() => {})
    }
    return
  }
  if (!started && !current.playing) return
  started = true
  void Noctis.updateMediaSession(current).catch(() => {})
}

/**
 * Desktop: the webview publishes to the system media controls on its own, and only a restart
 * with it switched off (src-tauri/src/media.rs) removes it. Then Noctis listens to the media
 * keys itself (global shortcuts there), so Play/Pause, Next and Previous still work.
 */
function initDesktopMediaControls() {
  const apply = (announce: boolean) =>
    invoke<boolean>('set_media_controls', { enabled: mediaControls.value })
      .then((current) => {
        if (!current && announce) notify(`Restart Noctis to ${mediaControls.value ? 'turn on' : 'turn off'} the system media controls`)
      })
      .catch((error) => writeLog('noctis', 'warn', "Couldn't save the media controls setting:", error))

  void apply(true)
  watch(mediaControls, () => void apply(true))

  void listen<string>('media-key', ({ payload }) => {
    if (payload === 'play-pause') void togglePlay()
    else if (payload === 'next') next()
    else if (payload === 'previous') previous()
    else if (payload === 'stop') stopPlayback()
  })
}

export function initMediaControls() {
  if (isDesktop) initDesktopMediaControls()
  if (!hasNoctisPlugin) return

  void Noctis.addListener('mediaAction', ({ action, position: target }) => {
    switch (action) {
      case 'play':
        void resume()
        break
      case 'pause':
        pause()
        break
      case 'next':
        next()
        break
      case 'previous':
        previous()
        break
      case 'seek':
        if (typeof target === 'number') seek(target)
        break
      case 'stop':
        stopPlayback()
        break
    }
  })

  // Position isn't watched continuously: the system extrapolates it from the last
  // update while playing, so only state changes and seeks need sending.
  watch([currentSong, currentIndex, isPlaying, duration, seekCount, hasNext], sync)

  // Loading counts: a song starting with the screen off needs the network too.
  watch(
    () => keepAwake.value && Boolean(currentSong.value) && (isPlaying.value || isLoading.value),
    (awake) => void Noctis.setKeepAwake({ awake }).catch(() => {}),
    { immediate: true },
  )

  watch(mediaControls, (enabled) => {
    if (enabled) {
      sync()
    } else if (started) {
      started = false
      void Noctis.clearMediaSession().catch(() => {})
    }
  })
}
