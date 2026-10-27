import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { computed, reactive, shallowReactive, shallowRef, watch } from 'vue'
import { haptic } from './haptics'
import { isNative } from './native'
import { navigate } from './navigation'
import * as notifications from './notifications'
import { cacheEnabled, downloadConcurrency, downloadNotifications, maxCacheMb } from './preferences'
import { writeLog } from './plugins/log'
import { persisted } from './storage'
import { fetchRange } from './http'
import { sourceOf, type Song } from './models'
import { services } from './services/registry'
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

class Cancelled extends Error {}

async function fetchAll(
  url: string,
  headers: Record<string, string> | undefined,
  total: number,
  onChunk: (base64: string, bytes: ArrayBuffer | undefined, index: number) => Promise<void>,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean = () => false,
) {
  let index = 0
  for (let start = 0; start < total; start += CHUNK, index++) {
    if (isCancelled()) throw new Cancelled()
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

async function save(song: Song, kind: OfflineKind, isCancelled?: () => boolean): Promise<OfflineEntry> {
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
    isCancelled,
  ).catch(async (error) => {
    // Don't leave half a file behind.
    if (isNative) await deleteFile(path)
    throw error
  })

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

/**
 * Downloads wait in a queue and run a few at a time: the limit is the user's setting
 * (Settings → Storage), lowered by what a song's service declares in `downloads`
 * (parallel transfers, minimum gap between starts) so rate-limited sources aren't hammered.
 * Whoever calls `download` (the app, a plugin) lands in the same queue.
 */
interface Job {
  song: Song
  source: string
  done: Promise<void>
  finish: () => void
  cancelled: boolean
}

const pending: Job[] = []
const running = new Map<string, Job>()
/** `running`, but reactive, for the notifications. */
export const nowRunning = shallowReactive(new Map<string, Song>())
/** Songs waiting for their turn, in order (for the download queue page). */
export const waiting = shallowRef<Song[]>([])
/** Songs that failed, with why, until retried or cleared. */
export const failures = shallowRef<{ song: Song; message: string }[]>([])
export const clearFailures = () => {
  failures.value = []
}
/** Songs waiting or downloading, kept so a killed app picks the queue up again on the next start. */
const savedQueue = persisted<Song[]>('noctis:download-queue', [], (value) => Array.isArray(value))

/** Fetches abort as the page goes away; those songs failed only on paper and must stay queued. */
let closing = false
window.addEventListener('pagehide', () => {
  closing = true
})
window.addEventListener('pageshow', () => {
  closing = false
})

const saveQueue = () => {
  waiting.value = pending.map((job) => job.song)
  if (closing) return
  savedQueue.value = [...running.values(), ...pending].map((job) => job.song)
}
const lastStart = new Map<string, number>()
let wakeTimer: number | undefined

/** What the download notification shows: the current run of downloads, from the first queued song until the queue empties. */
export const batch = reactive({ total: 0, done: 0, failed: 0, active: false, finished: false })


/** 0..1 across the whole run; songs in flight count by their own progress. */
export const batchFraction = computed(() => {
  if (batch.total === 0) return 0
  let partial = 0
  for (const transfer of transfers.values()) if (transfer.kind === 'download') partial += transfer.progress
  return Math.min(1, (batch.done + batch.failed + partial) / batch.total)
})

/** "3 out of 12": the second line, which is what a collapsed notification shows, so it stays readable whatever the song names. */
export const batchPosition = computed(() => `${Math.min(batch.done + batch.failed + 1, batch.total)} out of ${batch.total}`)

export const batchText = computed(() => {
  if (batch.active) return 'Downloading'
  const songs = `${batch.done} ${batch.done === 1 ? 'song' : 'songs'}`
  return batch.failed > 0 ? `Downloaded ${songs}, ${batch.failed} failed` : `Downloaded ${songs}`
})

const NOTIFICATION = 'noctis-downloads'

/**
 * The download progress as a system notification, in the foreground too; tapping it opens the
 * download queue page, where a run is cancelled or retried. With notifications off, that page
 * (Settings → Storage) or pressing a song's download button again does the same.
 */
watch(
  () => [batch.active, batch.finished, batchText.value, batchFraction.value, batchPosition.value] as const,
  ([active, finished, text, fraction, position]) => {
    if (!active && !finished) {
      notifications.close(NOTIFICATION)
      return
    }
    if (!downloadNotifications.value) return
    void notifications.show({
      id: NOTIFICATION,
      title: text,
      body: active ? position : undefined,
      progress: active ? fraction : undefined,
      ongoing: active,
      quiet: true,
      // What to do with the downloads (cancel one or all, retry) is on that page.
      onAction: () => navigate({ name: 'downloads-queue' }),
    })
  },
)

function startRun() {
  if (!batch.active) Object.assign(batch, { total: 0, done: 0, failed: 0, active: true, finished: false })
}

function endRun() {
  batch.active = false
  // Everything was cancelled: there's nothing to report.
  batch.finished = batch.total > 0
  if (batch.failed === 0 && batch.done > 0) haptic('confirm')
  else if (batch.failed > 0) haptic('reject')
}

const runningFor = (source: string) => [...running.values()].filter((job) => job.source === source).length

function pump() {
  window.clearTimeout(wakeTimer)
  let wait = Infinity
  for (let i = 0; i < pending.length && running.size < Math.max(1, downloadConcurrency.value); ) {
    const job = pending[i]
    const limits = services[job.source]?.downloads
    const gap = limits?.minIntervalMs ?? 0
    const sinceStart = Date.now() - (lastStart.get(job.source) ?? 0)
    if (runningFor(job.source) >= Math.max(1, limits?.concurrency ?? Infinity)) {
      i++
    } else if (sinceStart < gap) {
      wait = Math.min(wait, gap - sinceStart)
      i++
    } else {
      pending.splice(i, 1)
      waiting.value = pending.map((job) => job.song)
      lastStart.set(job.source, Date.now())
      running.set(job.song.id, job)
      nowRunning.set(job.song.id, job.song)
      void run(job)
    }
  }
  if (wait !== Infinity) wakeTimer = window.setTimeout(pump, wait)
}

async function run(job: Job) {
  const { song, finish } = job
  try {
    const entry = await save(song, 'download', () => job.cancelled)
    offline.value = { ...offline.value, [song.id]: { ...entry, kind: 'download' } }
    batch.done++
  } catch (error) {
    forgetStream(song.id)
    if (error instanceof Cancelled || job.cancelled) {
      batch.total--
    } else {
      batch.failed++
      failures.value = [...failures.value.filter((entry) => entry.song.id !== song.id), { song, message: (error as Error).message }]
      writeLog('noctis', 'warn', `Couldn't download "${song.title}": ${(error as Error).message}`)
    }
  } finally {
    transfers.delete(song.id)
    running.delete(song.id)
    nowRunning.delete(song.id)
    finish()
    saveQueue()
    if (pending.length === 0 && running.size === 0) endRun()
    else pump()
  }
}

function enqueue(song: Song): Promise<void> {
  const queued = pending.find((job) => job.song.id === song.id) ?? running.get(song.id)
  if (queued) return queued.done

  let finish = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  startRun()
  batch.total++
  failures.value = failures.value.filter((entry) => entry.song.id !== song.id)
  transfers.set(song.id, { kind: 'download', progress: 0 })
  pending.push({ song, source: sourceOf(song), done, finish, cancelled: false })
  saveQueue()
  pump()
  return done
}

/** Stop one song: drop it from the queue, or abort it between chunks if it's downloading. */
export function cancelDownload(id: string) {
  const index = pending.findIndex((job) => job.song.id === id)
  if (index >= 0) {
    const [job] = pending.splice(index, 1)
    transfers.delete(id)
    batch.total--
    job.finish()
    saveQueue()
    if (running.size === 0 && pending.length === 0 && batch.active) endRun()
    return
  }
  const job = running.get(id)
  if (job) job.cancelled = true
}

/** Stop everything: queued songs leave the queue, transfers in progress stop after their current chunk. */
export function cancelDownloads() {
  for (const id of [...pending.map((job) => job.song.id), ...running.keys()]) cancelDownload(id)
}

/** Pick up songs a previous session didn't finish. */
for (const song of savedQueue.value.slice()) {
  if (!offline.value[song.id]) void enqueue(song)
}
savedQueue.value = [...running.values(), ...pending].map((job) => job.song)

/**
 * Save a song on the device. Resolves when it's done (or failed); a download waits its turn
 * in the queue, a cache fill (`kind: 'cache'`, from playback) starts right away.
 */
export async function download(song: Song, kind: OfflineKind = 'download') {
  const existing = offline.value[song.id]
  if (existing) {
    // Promote a cached song to a download without fetching it again.
    if (kind === 'download' && existing.kind === 'cache') {
      offline.value = { ...offline.value, [song.id]: { ...existing, kind: 'download', song } }
    }
    return
  }
  const transfer = transfers.get(song.id)
  if (transfer) {
    // Already being cached: keep the file as a download once it lands.
    if (kind === 'download' && transfer.kind === 'cache') {
      transfer.kind = 'download'
      startRun()
      batch.total++
      const inFlight = cacheFills.get(song.id)
      await inFlight
      if (offline.value[song.id]) {
        offline.value = { ...offline.value, [song.id]: { ...offline.value[song.id], kind: 'download' } }
        batch.done++
      } else {
        batch.failed++
      }
      if (pending.length === 0 && running.size === 0) endRun()
      return
    }
    return kind === 'download' ? enqueue(song) : undefined
  }

  if (kind === 'download') return enqueue(song)

  const fill = cacheFill(song)
  cacheFills.set(song.id, fill)
  await fill
}

const cacheFills = new Map<string, Promise<void>>()

async function cacheFill(song: Song) {
  transfers.set(song.id, { kind: 'cache', progress: 0 })
  try {
    const entry = await save(song, 'cache')
    offline.value = { ...offline.value, [song.id]: entry }
    void trimCache()
  } catch {
    forgetStream(song.id)
  } finally {
    transfers.delete(song.id)
    cacheFills.delete(song.id)
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
