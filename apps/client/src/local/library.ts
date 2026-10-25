import { Capacitor } from '@capacitor/core'
import { ref, shallowRef } from 'vue'
import { hasNoctisPlugin, Noctis, type NativeMusicFile } from '../native'
import { writeLog } from '../plugins/log'
import { persisted } from '../storage'
import { idbDelete, idbGet, idbSet } from './idb'

/**
 * Music on this device.
 *
 * - Android: the whole device, from the system's media index (MediaStore), with the
 *   "Music and audio" permission. Folders it misses (.nomedia, unindexed places) can be
 *   added with the folder picker (Storage Access Framework); a file found both ways is
 *   listed once. Tags come from MediaStore or MediaMetadataRetriever; files play through
 *   Capacitor's content:// bridge.
 * - Browser: the File System Access API (showDirectoryPicker, Chromium); tags from
 *   music-metadata, loaded only when scanning; files play as blob: URLs. Browsers ask
 *   again for access after a restart, the first time a file plays.
 *
 * The index (and one small artwork per album) lives in IndexedDB.
 */

export interface LocalFolder {
  id: string
  name: string
  kind: 'android' | 'web'
  /** Android: the tree URI. (Browser handles are kept in IndexedDB.) */
  uri?: string
  scanned?: number
}

/** Pseudo folder id of the whole-device scan (Android). */
export const DEVICE_FOLDER = 'device'

export interface LocalTrack {
  /** "<folder id>/<path>" */
  id: string
  /** "<volume>:<path>" on Android, to drop files found both ways. */
  key?: string
  folderId: string
  path: string
  /** Android: the document URI. */
  uri?: string
  title: string
  artist: string
  album: string
  albumArtist: string
  track?: number
  disc?: number
  year?: number
  genre?: string
  /** Seconds. */
  duration?: number
  mimeType?: string
  size?: number
  bitrate?: number
  modified?: number
  /** Key of its artwork in `artwork` (shared by an album). */
  art?: string
}

type DirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>
  queryPermission?(options: { mode: 'read' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'read' }): Promise<PermissionState>
}

const AUDIO = /\.(mp3|flac|ogg|opus|m4a|aac|wav|aiff?|wma|ape|wv|webm)$/i

export const localFolders = persisted<LocalFolder[]>('noctis:local-folders', [], (value) => Array.isArray(value))
export const localTracks = shallowRef<LocalTrack[]>([])
/** Artwork key → data: URL (small, one per album). */
export const localArtwork = shallowRef(new Map<string, string>())
export const scanning = ref(false)
export const scanCount = ref(0)

/** Android: scan everything Android indexes (on by default), besides the picked folders. */
export const scanWholeDevice = persisted('noctis:local-whole-device', true, (value) => typeof value === 'boolean')
/** Android: "granted", "denied", "prompt"… (checked at startup). */
export const musicPermission = ref<string>('prompt')

export const nativeMusic = hasNoctisPlugin
export const browserMusic = !hasNoctisPlugin && typeof window !== 'undefined' && 'showDirectoryPicker' in window
/** Whether this device can add music folders at all. */
export const canAddFolders = nativeMusic || browserMusic

let loaded: Promise<void> | null = null

/** Read the index from IndexedDB (once). */
export function loadLocalLibrary(): Promise<void> {
  loaded ??= (async () => {
    try {
      localTracks.value = (await idbGet<LocalTrack[]>('tracks')) ?? []
      localArtwork.value = new Map(Object.entries((await idbGet<Record<string, string>>('artwork')) ?? {}))
    } catch (error) {
      writeLog('noctis', 'warn', "Couldn't read the local library:", error)
    }
  })()
  return loaded
}

async function save() {
  await idbSet('tracks', localTracks.value)
  await idbSet('artwork', Object.fromEntries(localArtwork.value))
}

const clean = (value: string | undefined) => value?.replace(/\u0000/g, '').trim() || undefined
const albumKey = (artist: string, album: string) => `${artist.toLowerCase()}\u0000${album.toLowerCase()}`

function fromNative(folder: LocalFolder, file: NativeMusicFile): LocalTrack {
  const name = file.path.split('/').pop()!.replace(/\.[^.]+$/, '')
  const artist = clean(file.artist) ?? clean(file.albumArtist) ?? 'Unknown artist'
  const album = clean(file.album) ?? (file.path.includes('/') ? file.path.split('/').at(-2)! : 'Unknown album')
  return {
    id: `${folder.id}/${file.path}`,
    key: file.key,
    folderId: folder.id,
    path: file.path,
    uri: file.uri,
    title: clean(file.title) ?? name,
    artist,
    album,
    albumArtist: clean(file.albumArtist) ?? artist,
    track: file.track,
    disc: file.disc,
    year: file.year,
    genre: clean(file.genre),
    duration: file.durationMs ? file.durationMs / 1000 : undefined,
    mimeType: file.mimeType,
    size: file.size,
    bitrate: file.bitrate ? Math.round(file.bitrate / 1000) : undefined,
    modified: file.modified,
  }
}

/** A downscaled JPEG data URL of an image blob (browser artwork). */
async function thumbnail(data: Uint8Array, type: string): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }))
    const scale = Math.min(1, 300 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return undefined
  }
}

async function* walk(dir: DirectoryHandle, path = ''): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue
    const child = path ? `${path}/${entry.name}` : entry.name
    if (entry.kind === 'directory') yield* walk(entry as DirectoryHandle, child)
    else if (AUDIO.test(entry.name)) yield { path: child, handle: entry as FileSystemFileHandle }
  }
}

/** Tracks from native files, fetching one artwork per album that has none yet. */
async function fromNativeFiles(folder: LocalFolder, files: NativeMusicFile[], artwork: Map<string, string>): Promise<LocalTrack[]> {
  const tracks: LocalTrack[] = []
  const tried = new Set<string>()
  for (const file of files) {
    const track = fromNative(folder, file)
    const key = albumKey(track.albumArtist, track.album)
    if (file.hasArtwork && !artwork.has(key) && !tried.has(key)) {
      tried.add(key)
      const { dataUrl } = await Noctis.getLocalArtwork({ uri: file.uri }).catch(() => ({ dataUrl: null }))
      if (dataUrl) artwork.set(key, dataUrl)
    }
    if (artwork.has(key)) track.art = key
    tracks.push(track)
  }
  return tracks
}

const WHOLE_DEVICE: LocalFolder = { id: DEVICE_FOLDER, name: 'This device', kind: 'android' }

/** Android: check (not request) the music permission. */
export async function checkMusicPermission(): Promise<string> {
  if (!nativeMusic) return 'denied'
  musicPermission.value = (await Noctis.checkMusicPermission().catch(() => ({ state: 'denied' }))).state
  return musicPermission.value
}

/** Android: ask for the music permission, then scan. Resolves to the new state. */
export async function requestMusicAccess(): Promise<string> {
  if (!nativeMusic) return 'denied'
  musicPermission.value = (await Noctis.requestMusicPermission().catch(() => ({ state: 'denied' }))).state
  if (musicPermission.value === 'granted') {
    scanWholeDevice.value = true
    await scanLocalLibrary()
  }
  return musicPermission.value
}

async function scanFolder(folder: LocalFolder, artwork: Map<string, string>): Promise<LocalTrack[]> {
  if (folder.kind === 'android' && folder.uri) {
    const { files } = await Noctis.scanMusicFolder({ uri: folder.uri })
    return fromNativeFiles(folder, files, artwork)
  }
  const tracks: LocalTrack[] = []

  const handle = await idbGet<DirectoryHandle>(`handle:${folder.id}`)
  if (!handle) throw new Error(`Access to "${folder.name}" was lost; remove and add it again`)
  if ((await handle.queryPermission?.({ mode: 'read' })) !== 'granted' && (await handle.requestPermission?.({ mode: 'read' })) !== 'granted') {
    throw new Error(`No access to "${folder.name}"`)
  }
  const { parseBlob, selectCover } = await import('music-metadata')
  for await (const { path, handle: fileHandle } of walk(handle)) {
    const file = await fileHandle.getFile()
    const name = path.split('/').pop()!.replace(/\.[^.]+$/, '')
    let track: LocalTrack = { id: `${folder.id}/${path}`, folderId: folder.id, path, title: name, artist: 'Unknown artist', album: path.split('/').at(-2) ?? 'Unknown album', albumArtist: 'Unknown artist', mimeType: file.type, size: file.size, modified: file.lastModified }
    try {
      const { common, format } = await parseBlob(file, { duration: false })
      const artist = clean(common.artist) ?? clean(common.albumartist) ?? 'Unknown artist'
      track = {
        ...track,
        title: clean(common.title) ?? name,
        artist,
        album: clean(common.album) ?? track.album,
        albumArtist: clean(common.albumartist) ?? artist,
        track: common.track.no ?? undefined,
        disc: common.disk.no ?? undefined,
        year: common.year,
        genre: clean(common.genre?.[0]),
        duration: format.duration,
        bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : undefined,
      }
      const key = albumKey(track.albumArtist, track.album)
      const cover = selectCover(common.picture)
      if (cover && !artwork.has(key)) {
        const url = await thumbnail(cover.data, cover.format)
        if (url) artwork.set(key, url)
      }
      if (artwork.has(key)) track.art = key
    } catch {
      /* untagged: the file name stands in */
    }
    tracks.push(track)
    scanCount.value++
  }
  return tracks
}

/** Rescan every folder (or one), replacing their tracks in the index. */
export async function scanLocalLibrary(only?: string): Promise<number> {
  if (scanning.value) return localTracks.value.length
  await loadLocalLibrary()
  scanning.value = true
  scanCount.value = 0
  const listener = nativeMusic ? await Noctis.addListener('musicScanProgress', ({ count }) => (scanCount.value = count)) : null
  try {
    const artwork = new Map(localArtwork.value)
    let tracks = localTracks.value

    // Android: the whole device first.
    if (nativeMusic && (!only || only === DEVICE_FOLDER)) {
      if (scanWholeDevice.value && (await checkMusicPermission()) === 'granted') {
        try {
          const { files } = await Noctis.scanMediaStore()
          const fresh = await fromNativeFiles(WHOLE_DEVICE, files, artwork)
          tracks = [...tracks.filter((track) => track.folderId !== DEVICE_FOLDER), ...fresh]
          writeLog('noctis', 'info', `Found ${fresh.length} songs on the device`)
        } catch (error) {
          writeLog('noctis', 'error', "Couldn't read the device's music:", error)
        }
      } else {
        tracks = tracks.filter((track) => track.folderId !== DEVICE_FOLDER)
      }
    }

    for (const folder of localFolders.value) {
      if (only && folder.id !== only) continue
      try {
        const fresh = await scanFolder(folder, artwork)
        tracks = [...tracks.filter((track) => track.folderId !== folder.id), ...fresh]
        localFolders.value = localFolders.value.map((item) => (item.id === folder.id ? { ...item, scanned: Date.now() } : item))
        writeLog('noctis', 'info', `Scanned ${fresh.length} songs in "${folder.name}"`)
      } catch (error) {
        writeLog('noctis', 'error', `Couldn't scan "${folder.name}":`, error)
      }
    }
    // A file in an extra folder that the device scan also found is listed once.
    const indexed = new Set(tracks.filter((track) => track.folderId === DEVICE_FOLDER && track.key).map((track) => track.key))
    tracks = tracks.filter((track) => track.folderId === DEVICE_FOLDER || !track.key || !indexed.has(track.key))

    // Drop artwork no track uses any more.
    const used = new Set(tracks.map((track) => track.art).filter(Boolean))
    localArtwork.value = new Map([...artwork].filter(([key]) => used.has(key)))
    localTracks.value = tracks
    await save()
    return tracks.length
  } finally {
    scanning.value = false
    await listener?.remove()
  }
}

/** Ask for a folder, add it and scan it. Resolves to the folder, or null if cancelled. */
export async function addLocalFolder(): Promise<LocalFolder | null> {
  let folder: LocalFolder
  if (nativeMusic) {
    let picked: { uri: string; name: string }
    try {
      picked = await Noctis.pickMusicFolder()
    } catch {
      return null
    }
    if (localFolders.value.some((item) => item.uri === picked.uri)) return null
    folder = { id: crypto.randomUUID().slice(0, 8), name: picked.name || 'Music', kind: 'android', uri: picked.uri }
  } else if (browserMusic) {
    let handle: DirectoryHandle
    try {
      handle = await (window as unknown as { showDirectoryPicker(options: { mode: 'read' }): Promise<DirectoryHandle> }).showDirectoryPicker({ mode: 'read' })
    } catch {
      return null
    }
    folder = { id: crypto.randomUUID().slice(0, 8), name: handle.name, kind: 'web' }
    await idbSet(`handle:${folder.id}`, handle)
  } else {
    throw new Error("This device can't add music folders")
  }
  localFolders.value = [...localFolders.value, folder]
  await scanLocalLibrary(folder.id)
  return folder
}

export async function removeLocalFolder(id: string) {
  const folder = localFolders.value.find((item) => item.id === id)
  if (!folder) return
  localFolders.value = localFolders.value.filter((item) => item.id !== id)
  localTracks.value = localTracks.value.filter((track) => track.folderId !== id)
  if (folder.kind === 'android' && folder.uri) await Noctis.releaseMusicFolder({ uri: folder.uri }).catch(() => {})
  else await idbDelete(`handle:${id}`)
  await save()
}

/** Something an <audio> element can play for a track. */
export async function localTrackUrl(track: LocalTrack): Promise<string> {
  if (track.uri) return Capacitor.convertFileSrc(track.uri)
  const handle = await idbGet<DirectoryHandle>(`handle:${track.folderId}`)
  if (!handle) throw new Error('This folder is no longer available')
  if ((await handle.queryPermission?.({ mode: 'read' })) !== 'granted' && (await handle.requestPermission?.({ mode: 'read' })) !== 'granted') {
    throw new Error('Allow access to the music folder to play this')
  }
  let dir: FileSystemDirectoryHandle = handle
  const parts = track.path.split('/')
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
  const file = await (await dir.getFileHandle(parts.at(-1)!)).getFile()
  return URL.createObjectURL(file)
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([].*?(remaster|version|edit|mix|live).*?[)\]]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The same song on this device (title and an artist match), if any. */
export function findLocalMatch(title: string, artists: string[]): LocalTrack | undefined {
  const wanted = normalize(title)
  const names = new Set(artists.map(normalize))
  return localTracks.value.find((track) => normalize(track.title) === wanted && (names.has(normalize(track.artist)) || names.has(normalize(track.albumArtist))))
}
