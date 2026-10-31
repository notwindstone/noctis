import { computed, watch } from 'vue'
import { download, offlineState } from './offline'
import { pauseHistory, saveLiked } from './preferences'
import { notify } from './snackbar'
import { persisted } from './storage'
import { sourceOf, type Artist, type Song } from './models'
import { setLiked } from './services/api'
import { services } from './services/registry'

/**
 * The on-device library. Likes are mirrored to the song's service when it takes them
 * (YouTube Music does when signed in); history and search history stay local.
 */

const isArray = (value: unknown) => Array.isArray(value)

/** Newest first. */
export const likedSongs = persisted<Song[]>('noctis:liked', [], isArray)

export interface HistoryEntry {
  song: Song
  playedAt: number
}

/** Newest first, one entry per song. */
export const history = persisted<HistoryEntry[]>('noctis:history', [], isArray)
export const searchHistory = persisted<string[]>('noctis:search-history', [], isArray)

const HISTORY_LIMIT = 300
const SEARCH_HISTORY_LIMIT = 30

const likedIds = computed(() => new Set(likedSongs.value.map((song) => song.id)))

export function isLiked(id: string): boolean {
  return likedIds.value.has(id)
}

export async function toggleLike(song: Song) {
  const liked = !isLiked(song.id)
  likedSongs.value = liked
    ? [song, ...likedSongs.value.filter((item) => item.id !== song.id)]
    : likedSongs.value.filter((item) => item.id !== song.id)

  // Settings → Storage → "Save liked songs".
  if (liked && saveLiked.value !== 'off') void download(song, saveLiked.value)

  try {
    await setLiked(song, liked)
  } catch {
    notify(`Saved on this device; ${services[sourceOf(song)]?.name ?? 'the service'} could not be updated.`)
  }
}

// Choosing "download" takes the songs liked so far along (the queue paces them).
watch(saveLiked, (choice) => {
  if (choice !== 'download') return
  const missing = likedSongs.value.filter((song) => offlineState(song.id) === 'none')
  if (missing.length === 0) return
  notify(`Downloading ${missing.length} liked ${missing.length === 1 ? 'song' : 'songs'}`)
  for (const song of missing) void download(song, 'download')
})

export function recordPlay(song: Song) {
  if (pauseHistory.value) return
  history.value = [
    { song, playedAt: Date.now() },
    ...history.value.filter((entry) => entry.song.id !== song.id),
  ].slice(0, HISTORY_LIMIT)
}

export function clearHistory() {
  history.value = []
}

export function recordSearch(query: string) {
  const trimmed = query.trim()
  if (!trimmed) return
  searchHistory.value = [
    trimmed,
    ...searchHistory.value.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, SEARCH_HISTORY_LIMIT)
}

export function removeSearch(query: string) {
  searchHistory.value = searchHistory.value.filter((item) => item !== query)
}

export function clearSearchHistory() {
  searchHistory.value = []
}

/** Artists you actually listen to, ranked by plays in the local history and likes. */
export const listenedArtists = computed<Artist[]>(() => {
  const scores = new Map<string, { artist: Artist; score: number }>()

  const add = (song: Song, weight: number) => {
    for (const ref of song.artists) {
      if (!ref.id) continue
      const entry = scores.get(ref.id) ?? {
        artist: { type: 'artist', id: ref.id, name: ref.name, thumbnail: song.thumbnail },
        score: 0,
      }
      entry.score += weight
      scores.set(ref.id, entry)
    }
  }

  history.value.forEach((entry, index) => add(entry.song, 1 + 1 / (index + 1)))
  likedSongs.value.forEach((song) => add(song, 2))

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((entry) => entry.artist)
})
