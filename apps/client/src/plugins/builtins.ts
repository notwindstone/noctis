import { isLiked, toggleLike } from '../library'
import { navigate } from '../navigation'
import { cancelDownload, download, isOnDevice, offlineState, removeOffline, transfers } from '../offline'
import { addToQueue, currentSong, playNext, playRadio, playSongs, removeFromQueue, shufflePlay, startRadio } from '../player'
import { notify } from '../snackbar'
import { closePlayer, confirm, openPlayer, queueOpen, showChoice, showPlayFrom, type ItemMenuRequest } from '../ui'
import { getAlbum, getPlaylist, shareLink } from '../services/api'
import type { Album, ArtistRef, Item, Playlist, Song } from '../models'
import { ActionCollections, registerAction, type ActionEntry } from './actions'

/**
 * Built-in actions and the entries that show them: the song / album / playlist / artist
 * menus and the full player's chips. Plugins add to the same collections and registry.
 */

type MenuContext<T extends Item = Item> = ItemMenuRequest & { item: T }
type PlayerContext = { song: Song }

const OWNER = 'noctis'

function go(route: Parameters<typeof navigate>[0]) {
  closePlayer()
  void navigate(route)
}

function goToArtist(artists: ArtistRef[]) {
  const linked = artists.filter((artist) => artist.id)
  if (linked.length === 1) return go({ name: 'artist', id: linked[0].id! })
  showChoice({
    title: 'Go to artist',
    options: linked.map((artist) => ({ value: artist.id!, label: artist.name })),
    value: '',
    onSelect: (id) => go({ name: 'artist', id }),
  })
}

async function songsOf(item: Album | Playlist): Promise<Song[]> {
  return item.type === 'album' ? (await getAlbum(item.id, item.source)).songs : (await getPlaylist(item.id, item.source)).songs
}

/** A link to share for an item, from its service (empty when it has none). */
export function linkFor(item: Item): string {
  return shareLink(item)
}

function registerBuiltInActions() {
  /* Play from */
  registerAction<MenuContext<Song>>('song.playFrom', ({ item }) => showPlayFrom({ song: item }), OWNER)

  /* Songs */
  registerAction<MenuContext<Song>>('song.playFromHere', ({ list }) => {
    if (list) playSongs(list.songs, list.index, list.title)
  }, OWNER)
  registerAction<MenuContext<Song>>('song.playNext', ({ item }) => playNext(item), OWNER)
  registerAction<MenuContext<Song>>('song.addToQueue', ({ item }) => addToQueue(item), OWNER)
  registerAction<MenuContext<Song>>('song.startRadio', ({ item }) => void startRadio(item), OWNER)
  registerAction<MenuContext<Song>>('song.like', ({ item }) => toggleLike(item), OWNER)
  registerAction<MenuContext<Song>>('song.download', ({ item }) => {
    if (offlineState(item.id) === 'downloading') cancelDownload(item.id)
    else void download(item)
  }, OWNER)
  registerAction<MenuContext<Song>>('song.removeDownload', ({ item, handlers }) => {
    confirm({
      title: 'Remove download?',
      message: `"${item.title}" will no longer be available offline.`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        await removeOffline(item.id)
        handlers.success()
      },
    })
  }, OWNER)
  registerAction<MenuContext<Song>>('song.removeFromQueue', ({ queueIndex }) => {
    if (queueIndex === undefined) return false
    removeFromQueue(queueIndex)
  }, OWNER)
  registerAction<MenuContext<Song>>('song.goToAlbum', ({ item }) => {
    if (!item.album) return false
    go({ name: 'album', id: item.album.id, source: item.source })
  }, OWNER)
  registerAction<MenuContext<Song>>('song.goToArtist', ({ item }) => goToArtist(item.artists), OWNER)

  /* Albums and playlists */
  registerAction<MenuContext<Album | Playlist>>('collection.play', async ({ item, handlers }) => {
    handlers.pending()
    playSongs(await songsOf(item), 0, item.title)
  }, OWNER)
  registerAction<MenuContext<Album | Playlist>>('collection.shuffle', async ({ item, handlers }) => {
    handlers.pending()
    shufflePlay(await songsOf(item), item.title)
  }, OWNER)
  registerAction<MenuContext<Album | Playlist>>('collection.addToQueue', async ({ item, handlers }) => {
    handlers.pending()
    for (const song of await songsOf(item)) addToQueue(song)
  }, OWNER)
  registerAction<MenuContext<Album | Playlist>>('collection.open', ({ item }) => {
    go(item.type === 'album' ? { name: 'album', id: item.id, source: item.source } : { name: 'playlist', id: item.id, source: item.source })
  }, OWNER)
  registerAction<MenuContext<Playlist>>('playlist.playRadio', ({ item }) => void playRadio(item), OWNER)
  registerAction<MenuContext<Album>>('album.goToArtist', ({ item }) => goToArtist(item.artists), OWNER)

  /* Artists */
  registerAction<MenuContext>('artist.open', ({ item }) => go({ name: 'artist', id: item.id, source: item.source }), OWNER)

  /* Any item */
  registerAction<MenuContext>('item.copyLink', async ({ item, handlers }) => {
    const link = linkFor(item)
    if (!link) return false
    try {
      await navigator.clipboard.writeText(link)
      handlers.success('Link copied')
    } catch {
      handlers.success(link)
    }
  }, OWNER)

  /* Player */
  registerAction<PlayerContext>('player.queue', () => {
    openPlayer()
    queueOpen.value = true
  }, OWNER)
  registerAction<PlayerContext>('player.download', ({ song, handlers }) => {
    const state = offlineState(song.id)
    if (state === 'downloaded') {
      confirm({
        title: 'Remove download?',
        message: `"${song.title}" will no longer be available offline.`,
        confirmLabel: 'Remove',
        destructive: true,
        onConfirm: async () => {
          await removeOffline(song.id)
          handlers.success()
        },
      })
    } else if (state === 'downloading') {
      cancelDownload(song.id)
    } else {
      void download(song, 'download')
    }
  }, OWNER)
}

const hasLink = ({ item }: MenuContext) => linkFor(item) !== ''

function defineBuiltInEntries() {
  const isPlaying = (item: Song) => currentSong.value?.id === item.id && currentSong.value?.source === item.source
  const song: ActionEntry<MenuContext<Song>>[] = [
    // In the player's menu (the song that's playing): where its audio comes from.
    { id: 'play-from', icon: 'tune', label: 'Play from…', action: 'song.playFrom', visible: ({ item }) => isPlaying(item) },
    { id: 'play-from-here', icon: 'play', label: 'Play from here', action: 'song.playFromHere', visible: ({ list }) => Boolean(list) },
    { id: 'play-next', icon: 'play-next', label: 'Play next', action: 'song.playNext' },
    { id: 'add-to-queue', icon: 'add-queue', label: 'Add to queue', action: 'song.addToQueue' },
    { id: 'start-radio', icon: 'radio', label: 'Start radio', action: 'song.startRadio' },
    {
      id: 'like',
      icon: 'favorite',
      label: ({ item }) => (isLiked(item.id) ? 'Remove from liked songs' : 'Like'),
      filled: ({ item }) => isLiked(item.id),
      action: 'song.like',
    },
    {
      id: 'download',
      icon: 'download',
      label: ({ item }) => {
        const state = offlineState(item.id)
        return state === 'downloading' ? 'Cancel download' : state === 'cached' ? 'Keep offline' : 'Download'
      },
      action: 'song.download',
      visible: ({ item }) => !isOnDevice(item) && offlineState(item.id) !== 'downloaded',
    },
    {
      id: 'remove-download',
      icon: 'delete',
      label: 'Remove download',
      action: 'song.removeDownload',
      visible: ({ item }) => offlineState(item.id) === 'downloaded',
    },
    {
      id: 'remove-from-queue',
      icon: 'close',
      label: 'Remove from queue',
      action: 'song.removeFromQueue',
      visible: ({ queueIndex }) => queueIndex !== undefined,
    },
    { id: 'go-to-album', icon: 'album', label: 'Go to album', action: 'song.goToAlbum', visible: ({ item }) => Boolean(item.album) },
    {
      id: 'go-to-artist',
      icon: 'artist',
      label: ({ item }) => {
        const linked = item.artists.filter((artist) => artist.id)
        return linked.length === 1 ? `Go to ${linked[0].name}` : 'Go to artist'
      },
      action: 'song.goToArtist',
      visible: ({ item }) => item.artists.some((artist) => artist.id),
    },
    { id: 'copy-link', icon: 'share', label: 'Copy link', action: 'item.copyLink', visible: hasLink },
  ]

  const collection = (kind: 'album' | 'playlist'): ActionEntry<MenuContext<Album | Playlist>>[] => [
    { id: 'play', icon: 'play', label: 'Play', action: 'collection.play', visible: ({ item }) => !(item.type === 'playlist' && item.radio) },
    {
      id: 'play-radio',
      icon: 'play',
      label: 'Play',
      action: 'playlist.playRadio',
      visible: ({ item }) => item.type === 'playlist' && Boolean(item.radio),
    },
    {
      id: 'shuffle',
      icon: 'shuffle',
      label: 'Shuffle',
      action: 'collection.shuffle',
      visible: ({ item }) => !(item.type === 'playlist' && item.radio),
    },
    {
      id: 'add-to-queue',
      icon: 'add-queue',
      label: 'Add to queue',
      action: 'collection.addToQueue',
      visible: ({ item }) => !(item.type === 'playlist' && item.radio),
    },
    {
      id: 'open',
      icon: kind === 'album' ? 'album' : 'playlist',
      label: kind === 'album' ? 'Go to album' : 'Open playlist',
      action: 'collection.open',
      visible: ({ item }) => !(item.type === 'playlist' && item.radio),
    },
  ]

  const album: ActionEntry<MenuContext<Album>>[] = [
    ...collection('album'),
    {
      id: 'go-to-artist',
      icon: 'artist',
      label: ({ item }) => {
        const linked = item.artists.filter((artist) => artist.id)
        return linked.length === 1 ? `Go to ${linked[0].name}` : 'Go to artist'
      },
      action: 'album.goToArtist',
      visible: ({ item }) => item.artists.some((artist) => artist.id),
    },
    { id: 'copy-link', icon: 'share', label: 'Copy link', action: 'item.copyLink', visible: hasLink },
  ]

  const playlist: ActionEntry<MenuContext<Playlist>>[] = [
    ...collection('playlist'),
    { id: 'copy-link', icon: 'share', label: 'Copy link', action: 'item.copyLink', visible: hasLink },
  ]

  const artist: ActionEntry<MenuContext>[] = [
    { id: 'open', icon: 'artist', label: 'Open artist', action: 'artist.open' },
    { id: 'copy-link', icon: 'share', label: 'Copy link', action: 'item.copyLink', visible: hasLink },
  ]

  const player: ActionEntry<PlayerContext>[] = [
    { id: 'queue', icon: 'queue', label: 'Up next', action: 'player.queue' },
    {
      id: 'download',
      icon: ({ song }) => (offlineState(song.id) === 'downloaded' ? 'downloaded' : 'download'),
      label: ({ song }) => {
        const state = offlineState(song.id)
        return state === 'downloaded' ? 'Downloaded' : state === 'downloading' ? 'Downloading' : 'Download'
      },
      filled: ({ song }) => offlineState(song.id) === 'downloaded',
      progress: ({ song }) => (offlineState(song.id) === 'downloading' ? (transfers.get(song.id)?.progress ?? 0) : undefined),
      action: 'player.download',
      visible: ({ song }) => !isOnDevice(song),
    },
  ]

  ActionCollections.songMenu.push(...(song as ActionEntry[]))
  ActionCollections.albumMenu.push(...(album as ActionEntry[]))
  ActionCollections.playlistMenu.push(...(playlist as ActionEntry[]))
  ActionCollections.artistMenu.push(...(artist as ActionEntry[]))
  ActionCollections.playerActions.push(...(player as ActionEntry[]))
}

let defined = false

export function defineBuiltIns() {
  if (defined) return
  defined = true
  registerBuiltInActions()
  defineBuiltInEntries()
}

/** Collection holding the menu entries for an item's type. */
export function menuCollection(item: Item): ActionEntry[] {
  switch (item.type) {
    case 'song':
      return ActionCollections.songMenu
    case 'album':
      return ActionCollections.albumMenu
    case 'playlist':
      return ActionCollections.playlistMenu
    case 'artist':
      return ActionCollections.artistMenu
  }
}

export function notifyHandlers(onDone?: () => void) {
  return {
    pending() {},
    success(message?: string) {
      if (message) notify(message)
      onDone?.()
    },
    error(message: string) {
      notify(message)
      onDone?.()
    },
    reset() {
      onDone?.()
    },
  }
}
