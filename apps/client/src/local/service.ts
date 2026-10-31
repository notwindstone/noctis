import { watch } from 'vue'
import type { Album, Artist, Item, Section, Song } from '../models'
import { defineService, removeService } from '../services/registry'
import type { ServiceDefinition } from '../services/types'
import { persisted } from '../storage'
import {
  checkMusicPermission,
  loadLocalLibrary,
  localArtwork,
  localFolders,
  localTrackUrl,
  localTracks,
  nativeMusic,
  requestMusicAccess,
  scanLocalLibrary,
  scanWholeDevice,
  type LocalTrack,
} from './library'

const askedForMusic = persisted('noctis:local-asked', false, (value) => typeof value === 'boolean')

/**
 * Music on this device as a service ("On this device"): home rows, search, albums,
 * artists and streams: on Android the whole device (plus extra folders), elsewhere the
 * folders in Settings → Local music. It's defined while there's any music; ids are
 * local to the device.
 */

export const DEVICE_SERVICE = 'device'

/** A short stable id for a string (album and artist keys). */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

const artistId = (name: string) => `ar-${hash(name.toLowerCase())}`
const albumId = (track: LocalTrack) => `al-${hash(`${track.albumArtist.toLowerCase()}\u0000${track.album.toLowerCase()}`)}`

const art = (track: LocalTrack) => (track.art ? localArtwork.value.get(track.art) : undefined)

export function toSong(track: LocalTrack): Song {
  return {
    type: 'song',
    source: DEVICE_SERVICE,
    id: track.id,
    title: track.title,
    artists: [{ id: artistId(track.artist), name: track.artist }],
    album: { id: albumId(track), name: track.album },
    duration: track.duration,
    thumbnail: art(track),
  }
}

function albums(): Map<string, LocalTrack[]> {
  const groups = new Map<string, LocalTrack[]>()
  for (const track of localTracks.value) {
    const id = albumId(track)
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(track)
  }
  for (const tracks of groups.values()) tracks.sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 999) - (b.track ?? 999) || a.title.localeCompare(b.title))
  return groups
}

function toAlbum(id: string, tracks: LocalTrack[]): Album {
  const first = tracks[0]
  return {
    type: 'album',
    source: DEVICE_SERVICE,
    id,
    title: first.album,
    artists: [{ id: artistId(first.albumArtist), name: first.albumArtist }],
    year: first.year ? String(first.year) : undefined,
    thumbnail: tracks.map(art).find(Boolean),
  }
}

function artists(): Artist[] {
  const counts = new Map<string, { name: string; albums: Set<string>; thumbnail?: string }>()
  for (const track of localTracks.value) {
    const id = artistId(track.albumArtist)
    const entry = counts.get(id) ?? { name: track.albumArtist, albums: new Set<string>() }
    entry.albums.add(albumId(track))
    entry.thumbnail ??= art(track)
    counts.set(id, entry)
  }
  return [...counts.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([id, entry]) => ({ type: 'artist', source: DEVICE_SERVICE, id, name: entry.name, subtitle: `${entry.albums.size} ${entry.albums.size === 1 ? 'album' : 'albums'}`, thumbnail: entry.thumbnail }))
}

const section = (id: string, title: string, items: Item[], layout: Section['layout'] = 'carousel'): Section[] => (items.length ? [{ id, title, items, layout }] : [])
const matches = (query: string, ...fields: (string | undefined)[]) => fields.some((field) => field?.toLowerCase().includes(query))

const service: ServiceDefinition = {
  name: 'On this device',
  icon: 'device-music',

  home: {
    async load() {
      await loadLocalLibrary()
      const groups = albums()
      const recent = [...localTracks.value].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, 20)
      const shuffled = [...groups.entries()].sort(() => Math.random() - 0.5).slice(0, 16)
      return {
        sections: [
          ...section('recent', 'Recently added', recent.map(toSong), 'quick-picks'),
          ...section('albums', 'Albums', shuffled.map(([id, tracks]) => toAlbum(id, tracks))),
          ...section('artists', 'Artists', artists().slice(0, 20)),
        ],
        filters: [],
        selectedFilter: null,
        hasMore: false,
      }
    },
  },

  search: {
    filters: [
      { id: 'songs', label: 'Songs' },
      { id: 'albums', label: 'Albums' },
      { id: 'artists', label: 'Artists' },
    ],
    async query({ query, type }) {
      await loadLocalLibrary()
      const q = query.trim().toLowerCase()
      const songs = localTracks.value.filter((track) => matches(q, track.title, track.artist, track.album)).slice(0, 100).map(toSong)
      const albumItems = [...albums().entries()].filter(([, tracks]) => matches(q, tracks[0].album, tracks[0].albumArtist)).map(([id, tracks]) => toAlbum(id, tracks))
      const artistItems = artists().filter((artist) => matches(q, artist.name))
      if (type === 'songs') return { sections: [], items: songs, hasMore: false }
      if (type === 'albums') return { sections: [], items: albumItems, hasMore: false }
      if (type === 'artists') return { sections: [], items: artistItems, hasMore: false }
      return { sections: [...section('songs', 'Songs', songs.slice(0, 20), 'list'), ...section('albums', 'Albums', albumItems), ...section('artists', 'Artists', artistItems)], items: [], hasMore: false }
    },
  },

  albums: {
    async get({ id }) {
      await loadLocalLibrary()
      const tracks = albums().get(id)
      if (!tracks) throw new Error('This album is no longer on the device')
      const album = toAlbum(id, tracks)
      return { id, kind: 'album', title: album.title, subtitle: album.year, thumbnail: album.thumbnail, artists: album.artists, year: album.year, songs: tracks.map(toSong), hasMore: false, sections: [] }
    },
  },

  artists: {
    async get({ id }) {
      await loadLocalLibrary()
      const own = [...albums().entries()].filter(([, tracks]) => artistId(tracks[0].albumArtist) === id)
      const songs = localTracks.value.filter((track) => artistId(track.artist) === id)
      const name = own[0]?.[1][0].albumArtist ?? songs[0]?.artist ?? 'Unknown artist'
      return {
        id,
        name,
        thumbnail: own.map(([, tracks]) => tracks.map(art).find(Boolean)).find(Boolean),
        sections: [...section('songs', 'Songs', songs.slice(0, 10).map(toSong), 'list'), ...section('albums', 'Albums', own.map(([albumKey, tracks]) => toAlbum(albumKey, tracks)))],
      }
    },
  },

  library: {
    async artists() {
      await loadLocalLibrary()
      return artists()
    },
  },

  streams: {
    async resolve({ song }) {
      await loadLocalLibrary()
      const track = localTracks.value.find((item) => item.id === song.id)
      if (!track) throw new Error('This song is no longer on the device')
      const url = await localTrackUrl(track)
      return { url, mimeType: track.mimeType ?? 'audio/mpeg', bitrate: (track.bitrate ?? 0) * 1000, contentLength: track.size, expiresAt: Date.now() + 24 * 3600_000 }
    },
  },

  links: { share: () => undefined },
}

/**
 * Keep the service defined while there's music on the device, and on Android refresh
 * the index at startup (MediaStore is quick to read; only new albums need artwork).
 */
export function initDeviceService() {
  watch(
    () => localTracks.value.length > 0 || localFolders.value.length > 0,
    (has) => (has ? defineService(DEVICE_SERVICE, service) : removeService(DEVICE_SERVICE)),
    { immediate: true },
  )
  void loadLocalLibrary().then(async () => {
    if (!nativeMusic) return
    // Ask for the music permission once, on first launch; after that it's in Settings → Local music.
    if (scanWholeDevice.value && !askedForMusic.value) {
      askedForMusic.value = true
      if ((await checkMusicPermission()) !== 'granted') {
        await requestMusicAccess()
        return
      }
    }
    if (scanWholeDevice.value || localFolders.value.length > 0) void scanLocalLibrary()
  })
}
