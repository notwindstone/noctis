import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { computed, reactive, watch } from 'vue'
import { haptic } from './haptics'
import { isNative } from './native'
import { cacheEnabled, maxCacheMb } from './preferences'
import { notify } from './snackbar'
import { persisted } from './storage'
import { fetchRange } from './http'
import type { Song } from './models'
import { forgetStream, resolveStream } from './services/stream'

/**
 * Offline audio. "Downloads" are kept until removed; the "cache" is filled
 * automatically with songs you play and trimmed (least recently played first) to the
 * size set in Settings → Storage.
 *
 * googlevideo only serves bounded byte ranges, so files are fetched in 1 MB chunks.
 * On Android they go to the app's data directory; in the browser, to Cache Storage.
 */

export type OfflineKind = 'download' | 'cache'

export interface OfflineEntry {
  song: Song
  kind: OfflineKind
  path: string
  mimeType: string
  size: number
  savedAt: number
  lastPlayed: number
}

const CHUNK = 1024 * 1024
const WEB_CACHE = 'noctis-audio'

export const offline = persisted<Record<string, OfflineEntry>>(
  'noctis:offline',
  {},
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
)

/** Songs currently being fetched, with progress 0..1. */
export const transfers = reactive(new Map<string, { kind: OfflineKind; progress: number }>())

const sortedEntries = (kind: OfflineKind) =>
  computed(() =>
    Object.values(offline.value)
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.savedAt - a.savedAt),
  )

export const downloads = sortedEntries('download')
export const cached = sortedEntries('cache')

export const usage = computed(() => {
  let download = 0
  let cache = 0
  for (const entry of Object.values(offline.value)) {
    if (entry.kind === 'download') download += entry.size
    else cache += entry.size
  }
  return { download, cache }
})

export type OfflineState = 'none' | 'cached' | 'downloading' | 'downloaded'

export function offlineState(id: string): OfflineState {
  const transfer = transfers.get(id)
  if (transfer?.kind === 'download') return 'downloading'
  const entry = offline.value[id]
  if (entry?.kind === 'download') return 'downloaded'
  if (entry?.kind === 'cache') return 'cached'
  return 'none'
}

function extensionFor(mimeType: string): string {
  return mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'm4a' : 'audio'
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

async function fetchAll(
  url: string,
  headers: Record<string, string> | undefined,
  total: number,
  onChunk: (base64: string, bytes: ArrayBuffer | undefined, index: number) => Promise<void>,
  onProgress: (fraction: number) => void,
) {
  let index = 0
  for (let start = 0; start < total; start += CHUNK, index++) {
    const end = Math.min(start + CHUNK, total) - 1
    let attempt = 0
    for (;;) {
      const result = await fetchRange(url, start, end, headers)
      if (result.status === 200 || result.status === 206) {
        const base64 = result.base64 ?? (result.bytes ? bytesToBase64(result.bytes) : '')
        await onChunk(base64, result.bytes, index)
        break
      }
      if (++attempt >= 3) throw new Error(`HTTP ${result.status} at byte ${start}`)
    }
    onProgress((end + 1) / total)
  }
}

async function save(song: Song, kind: OfflineKind): Promise<OfflineEntry> {
  const stream = await resolveStream(song)
  const total = stream.contentLength
  if (!total) throw new Error('Unknown file size')

  // Ids from other services may contain ":" ("spotify:track:…"); keep file names plain.
  const path = `audio/${song.id.replace(/[^\w.-]/g, '_')}.${extensionFor(stream.mimeType)}`
  const webParts: ArrayBuffer[] = []

  await fetchAll(
    stream.fetchUrl ?? stream.url,
    stream.fetchHeaders,
    total,
    async (base64, bytes, index) => {
      if (isNative) {
        if (index === 0) {
          await Filesystem.writeFile({ path, data: base64, directory: Directory.Data, recursive: true })
        } else {
          await Filesystem.appendFile({ path, data: base64, directory: Directory.Data })
        }
      } else if (bytes) {
        webParts.push(bytes)
      }
    },
    (progress) => {
      const transfer = transfers.get(song.id)
      if (transfer) transfer.progress = progress
    },
  )

  if (!isNative) {
    const cache = await caches.open(WEB_CACHE)
    await cache.put(
      new Request(`/offline/${path}`),
      new Response(new Blob(webParts, { type: stream.mimeType }), { headers: { 'content-type': stream.mimeType } }),
    )
  }

  return { song, kind, path, mimeType: stream.mimeType, size: total, savedAt: Date.now(), lastPlayed: Date.now() }
}

async function deleteFile(path: string) {
  try {
    if (isNative) {
      await Filesystem.deleteFile({ path, directory: Directory.Data })
    } else {
      const cache = await caches.open(WEB_CACHE)
      await cache.delete(new Request(`/offline/${path}`))
    }
  } catch {
    /* already gone */
  }
}

export async function download(song: Song, kind: OfflineKind = 'download') {
  const existing = offline.value[song.id]
  if (existing) {
    // Promote a cached song to a download without fetching it again.
    if (kind === 'download' && existing.kind === 'cache') {
      offline.value = { ...offline.value, [song.id]: { ...existing, kind: 'download', song } }
      notify(`Downloaded "${song.title}"`)
    }
    return
  }
  if (transfers.has(song.id)) {
    const transfer = transfers.get(song.id)
    if (transfer && kind === 'download') transfer.kind = 'download'
    return
  }

  transfers.set(song.id, { kind, progress: 0 })
  try {
    const entry = await save(song, kind)
    const finalKind = transfers.get(song.id)?.kind ?? kind
    offline.value = { ...offline.value, [song.id]: { ...entry, kind: finalKind } }
    if (finalKind === 'download') {
      haptic('confirm')
      notify(`Downloaded "${song.title}"`)
    } else {
      void trimCache()
    }
  } catch (error) {
    forgetStream(song.id)
    if (kind === 'download') {
      haptic('reject')
      notify(`Couldn't download "${song.title}": ${(error as Error).message}`)
    }
  } finally {
    transfers.delete(song.id)
  }
}

export async function removeOffline(id: string) {
  const entry = offline.value[id]
  if (!entry) return
  const next = { ...offline.value }
  delete next[id]
  offline.value = next
  await deleteFile(entry.path)
}

async function clearKind(kind: OfflineKind) {
  const entries = Object.values(offline.value).filter((entry) => entry.kind === kind)
  const next = { ...offline.value }
  for (const entry of entries) delete next[entry.song.id]
  offline.value = next
  await Promise.all(entries.map((entry) => deleteFile(entry.path)))
}

export const clearCache = () => clearKind('cache')
export const clearDownloads = () => clearKind('download')

/** Drop least recently played cached songs until the cache fits its limit. */
export async function trimCache() {
  const limit = maxCacheMb.value * 1024 * 1024
  if (limit <= 0) return

  const entries = Object.values(offline.value)
    .filter((entry) => entry.kind === 'cache')
    .sort((a, b) => a.lastPlayed - b.lastPlayed)

  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries) {
    if (total <= limit) break
    total -= entry.size
    await removeOffline(entry.song.id)
  }
}

watch(maxCacheMb, () => void trimCache())
watch(cacheEnabled, (enabled) => {
  if (!enabled) void clearCache()
})

let currentObjectUrl: string | null = null

/** A playable URL for a song stored on the device, or null if it isn't. */
export async function localSource(id: string): Promise<string | null> {
  const entry = offline.value[id]
  if (!entry) return null

  offline.value = { ...offline.value, [id]: { ...entry, lastPlayed: Date.now() } }

  try {
    if (isNative) {
      const { uri } = await Filesystem.getUri({ path: entry.path, directory: Directory.Data })
      return Capacitor.convertFileSrc(uri)
    }

    const cache = await caches.open(WEB_CACHE)
    const response = await cache.match(new Request(`/offline/${entry.path}`))
    if (!response) throw new Error('missing')
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = URL.createObjectURL(await response.blob())
    return currentObjectUrl
  } catch {
    // The file vanished (cleared storage); forget the entry so it can be fetched again.
    const next = { ...offline.value }
    delete next[id]
    offline.value = next
    return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
