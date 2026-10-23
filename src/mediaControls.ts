import { watch } from 'vue'
import { hasNoctisPlugin, Noctis, type MediaState } from './native'
import {
  currentIndex,
  currentSong,
  duration,
  hasNext,
  isPlaying,
  next,
  pause,
  position,
  previous,
  resume,
  seek,
  seekCount,
  stopPlayback,
} from './player'
import { mediaControls } from './preferences'
import { artistNames } from './ytm/models'
import { thumbnailAt } from './ytm/thumbnails'

/**
 * Mirrors the player into Android's media session: the notification and the lock screen
 * show the song, a progress bar and prev / play-pause / next, and drive the player back.
 * The foreground service behind it also keeps playback alive in the background.
 *
 * The session only starts once something has actually played, so a restored queue
 * doesn't put a notification up on launch.
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

export function initMediaControls() {
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

  watch(mediaControls, (enabled) => {
    if (enabled) {
      sync()
    } else if (started) {
      started = false
      void Noctis.clearMediaSession().catch(() => {})
    }
  })
}
