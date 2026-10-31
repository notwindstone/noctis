import { computed, ref } from 'vue'
import type { CollectionPage, Playlist, Song } from './models'
import { notify } from './snackbar'
import { persisted } from './storage'
import { coverUrl, credentials, subsonic, type SubsonicPayload } from './subsonic/client'
import { confirm, showChoice, showTextDialog } from './ui'

/**
 * Your own playlists, of two kinds:
 *
 * - on this device: any songs, from any service, kept here (`source` is LOCAL_PLAYLISTS);
 * - on the server you're signed in to (a Noctis or any OpenSubsonic server): synced with it,
 *   and visible from every device that signs in. The server only knows its own songs, so only
 *   those can go in (`source` is the server's service id, like the rest of its content).
 *
 * "Add to playlist" asks which one, "New playlist" asks what kind. `playlistsVersion` goes up
 * whenever either kind changes, so screens showing a playlist or the list of them reload.
 */

export const LOCAL_PLAYLISTS = 'playlists'
/** The server's service id (src/subsonic/service.ts). */
const SERVER = 'noctis-server'

interface StoredPlaylist {
  id: string
  name: string
  songs: Song[]
  created: number
  changed: number
}

const localLists = persisted<StoredPlaylist[]>('noctis:playlists', [], (value) => Array.isArray(value))

export const playlistsVersion = ref(0)
const changed = () => playlistsVersion.value++

const isLocal = (source?: string) => source === LOCAL_PLAYLISTS

/** Whether there's an account on a server to keep playlists with (guests can't). */
export const serverWritable = computed(() => credentials.value !== null)

const plural = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`

/* ------------------------------------------------------------------ *
 * On this device
 * ------------------------------------------------------------------ */

function toItem(list: StoredPlaylist): Playlist {
  return {
    type: 'playlist',
    source: LOCAL_PLAYLISTS,
    id: list.id,
    title: list.name,
    subtitle: `${plural(list.songs.length)} • On this device`,
    thumbnail: list.songs.find((song) => song.thumbnail)?.thumbnail,
    editable: true,
  }
}

/** Newest change first. */
export const localPlaylistItems = computed<Playlist[]>(() => [...localLists.value].sort((a, b) => b.changed - a.changed).map(toItem))

export function localPlaylistPage(id: string): CollectionPage {
  const list = localLists.value.find((item) => item.id === id)
  if (!list) throw new Error('This playlist is gone')
  const item = toItem(list)
  return {
    id,
    kind: 'playlist',
    title: list.name,
    subtitle: 'On this device',
    thumbnail: item.thumbnail,
    artists: [],
    songs: list.songs,
    hasMore: false,
    sections: [],
    editable: true,
  }
}

function update(id: string, change: (list: StoredPlaylist) => StoredPlaylist) {
  localLists.value = localLists.value.map((list) => (list.id === id ? { ...change(list), changed: Date.now() } : list))
  changed()
}

function createLocal(name: string, songs: Song[]): StoredPlaylist {
  const list: StoredPlaylist = { id: `pl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), songs: dedupe(songs), created: Date.now(), changed: Date.now() }
  localLists.value = [list, ...localLists.value]
  changed()
  return list
}

const dedupe = (songs: Song[]) => songs.filter((song, index) => songs.findIndex((other) => other.id === song.id && other.source === song.source) === index)
const same = (a: Song, b: Song) => a.id === b.id && a.source === b.source

/** Songs not yet in the playlist go to its end; returns how many were new. */
function addLocal(id: string, songs: Song[]): number {
  const list = localLists.value.find((item) => item.id === id)
  if (!list) return 0
  const fresh = dedupe(songs).filter((song) => !list.songs.some((other) => same(other, song)))
  if (fresh.length > 0) update(id, (current) => ({ ...current, songs: [...current.songs, ...fresh] }))
  return fresh.length
}

/* ------------------------------------------------------------------ *
 * On the server
 * ------------------------------------------------------------------ */

export function serverPlaylistItem(playlist: SubsonicPayload): Playlist {
  return {
    type: 'playlist',
    source: SERVER,
    id: playlist.id,
    title: playlist.name,
    subtitle: `${plural(playlist.songCount ?? 0)}${playlist.owner ? ` • ${playlist.owner}` : ''}`,
    thumbnail: coverUrl(playlist.coverArt),
    // Public playlists of other people are listed too, but they're theirs to change.
    editable: credentials.value !== null && playlist.owner === credentials.value.username,
  }
}

export async function serverPlaylists(): Promise<Playlist[]> {
  const body = await subsonic('getPlaylists')
  return ((body.playlists?.playlist ?? []) as SubsonicPayload[]).map(serverPlaylistItem)
}

async function createServer(name: string, songs: Song[]): Promise<string> {
  const body = await subsonic('createPlaylist', { name: name.trim(), songId: songs.map((song) => song.id) })
  return body.playlist?.id
}

async function addServer(id: string, songs: Song[]) {
  await subsonic('updatePlaylist', { playlistId: id, songIdToAdd: songs.map((song) => song.id) })
}

async function removeServer(id: string, songId: string) {
  const entries = ((await subsonic('getPlaylist', { id })).playlist?.entry ?? []) as SubsonicPayload[]
  const index = entries.findIndex((entry) => entry.id === songId)
  if (index === -1) return
  await subsonic('updatePlaylist', { playlistId: id, songIndexToRemove: [String(index)] })
}

const isServerSong = (song: Song) => song.source === SERVER

function failed(action: string, error: unknown) {
  notify(`Couldn't ${action}: ${error instanceof Error ? error.message : String(error)}`)
}

/* ------------------------------------------------------------------ *
 * Everyone's list of them
 * ------------------------------------------------------------------ */

/** Playlists of yours that the account library (the active service's) doesn't list already: those on this device, and the server's when another service is active. */
export async function ownPlaylists(serverListedElsewhere: boolean): Promise<Playlist[]> {
  const lists: Playlist[] = [...localPlaylistItems.value]
  if (!serverListedElsewhere && credentials.value !== null) {
    try {
      lists.push(...(await serverPlaylists()))
    } catch {
      /* the server being away shouldn't hide the ones on the device */
    }
  }
  return lists
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

type Kind = 'local' | 'server'

function askName(title: string, initial: string, confirmLabel: string, onName: (name: string) => void | Promise<void>) {
  showTextDialog({ title, placeholder: 'Playlist name', initial, confirmLabel, capitalize: true, onConfirm: onName })
}

async function create(kind: Kind, name: string, songs: Song[]) {
  if (kind === 'local') {
    createLocal(name, songs)
    notify(songs.length > 0 ? `Created "${name.trim()}" with ${plural(songs.length)}` : `Created "${name.trim()}"`)
    return
  }
  try {
    await createServer(name, songs.filter(isServerSong))
    changed()
    notify(`Created "${name.trim()}" on the server`)
  } catch (error) {
    failed('create the playlist', error)
  }
}

/** "New playlist": on this device, or on the server when you're signed in to one. */
export function newPlaylistDialog(songs: Song[] = []) {
  const onServer = serverWritable.value && songs.every(isServerSong)
  if (!onServer) return askName('New playlist', '', 'Create', (name) => create('local', name, songs))
  showChoice({
    title: 'New playlist',
    value: '',
    options: [
      { value: 'local', label: 'On this device', description: 'Any songs, from any service', icon: 'devices' },
      { value: 'server', label: 'On the server', description: 'Synced with your server and your other devices', icon: 'cloud' },
    ],
    onSelect: (kind) => askName('New playlist', '', 'Create', (name) => create(kind as Kind, name, songs)),
  })
}

/** "Add to playlist": choose one (or make one), then the songs go in. */
export async function addToPlaylistDialog(songs: Song[]) {
  songs = dedupe(songs)
  if (songs.length === 0) return notify('There is nothing to add')

  const onServer = serverWritable.value && songs.every(isServerSong)
  let remote: Playlist[] = []
  if (onServer) remote = (await serverPlaylists().catch(() => [])).filter((list) => list.editable)

  showChoice({
    title: songs.length === 1 ? 'Add to playlist' : `Add ${plural(songs.length)} to a playlist`,
    value: '',
    options: [
      { value: 'new:local', label: 'New playlist', description: 'On this device', icon: 'add' as const },
      ...(onServer ? [{ value: 'new:server', label: 'New server playlist', description: 'Synced with your server', icon: 'add' as const }] : []),
      ...localPlaylistItems.value.map((list) => ({ value: `local:${list.id}`, label: list.title, description: list.subtitle, icon: 'playlist' as const })),
      ...remote.map((list) => ({ value: `server:${list.id}`, label: list.title, description: list.subtitle, icon: 'cloud' as const })),
    ],
    onSelect(value) {
      const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
      if (kind === 'new') return askName('New playlist', '', 'Create', (name) => create(id as Kind, name, songs))
      if (kind === 'local') {
        const added = addLocal(id, songs)
        const name = localLists.value.find((list) => list.id === id)?.name ?? 'the playlist'
        notify(added === 0 ? `Already in "${name}"` : `Added ${plural(added)} to "${name}"`)
        return
      }
      const name = remote.find((list) => list.id === id)?.title ?? 'the playlist'
      addServer(id, songs).then(
        () => {
          changed()
          notify(`Added ${plural(songs.length)} to "${name}"`)
        },
        (error) => failed('add to the playlist', error),
      )
    },
  })
}

export async function removeFromPlaylist(playlist: { id: string; source?: string }, song: Song) {
  if (isLocal(playlist.source)) {
    update(playlist.id, (list) => ({ ...list, songs: list.songs.filter((other) => !same(other, song)) }))
    notify(`Removed "${song.title}"`)
    return
  }
  try {
    await removeServer(playlist.id, song.id)
    changed()
    notify(`Removed "${song.title}"`)
  } catch (error) {
    failed('remove the song', error)
  }
}

export function renamePlaylist(playlist: Playlist) {
  askName('Rename playlist', playlist.title, 'Rename', async (name) => {
    if (isLocal(playlist.source)) return update(playlist.id, (list) => ({ ...list, name: name.trim() }))
    try {
      await subsonic('updatePlaylist', { playlistId: playlist.id, name: name.trim() })
      changed()
    } catch (error) {
      failed('rename the playlist', error)
    }
  })
}

export function deletePlaylist(playlist: Playlist, then?: () => void) {
  confirm({
    title: `Delete "${playlist.title}"?`,
    message: isLocal(playlist.source) ? 'The songs stay where they are; only this list goes.' : 'It is deleted from the server, for every device.',
    confirmLabel: 'Delete',
    destructive: true,
    async onConfirm() {
      if (isLocal(playlist.source)) {
        localLists.value = localLists.value.filter((list) => list.id !== playlist.id)
        changed()
      } else {
        try {
          await subsonic('deletePlaylist', { id: playlist.id })
          changed()
        } catch (error) {
          return failed('delete the playlist', error)
        }
      }
      then?.()
    },
  })
}

/** Copy a playlist of this device to the server: it keeps the songs the server knows. */
export async function uploadPlaylist(playlist: Playlist) {
  const list = localLists.value.find((item) => item.id === playlist.id)
  if (!list) return
  const known = list.songs.filter(isServerSong)
  if (known.length === 0) return notify('None of these songs are from the server, so there is nothing to sync')
  try {
    await createServer(list.name, known)
    changed()
    const skipped = list.songs.length - known.length
    notify(`Uploaded "${list.name}"${skipped > 0 ? ` (${plural(skipped)} from other services stayed out)` : ''}`)
  } catch (error) {
    failed('upload the playlist', error)
  }
}
