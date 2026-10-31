import type { Album, Artist, ArtistPage, CollectionPage, Item, Song, StreamInfo } from './host'
import { Noctis } from './host'
import { call } from './instances'

/**
 * TIDAL through hifi-api instances (the "API instances" in Monochrome's INSTANCES.md:
 * api.monochrome.tf, the qqdl.site ones…). Search, albums and artists are TIDAL's, as in
 * Monochrome; streams come from /track/?quality=LOSSLESS, whose manifest (base64 JSON)
 * lists the FLAC URL, like Monochrome's extractStreamUrlFromManifest.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>

const SOURCE = 'monochrome'
const { StreamError } = Noctis.libs.stream

export const tidalId = (id: number | string, isrc?: string) => `${SOURCE}:tidal:${id}${isrc ? `:${isrc}` : ''}`
export const tidalAlbumId = (id: number | string) => `${SOURCE}:tidal-album:${id}`
export const tidalArtistId = (id: number | string) => `${SOURCE}:tidal-artist:${id}`
export const isTidal = (id: string) => id.startsWith(`${SOURCE}:tidal`)
const after = (id: string, kind: string) => id.slice(`${SOURCE}:${kind}:`.length)

export const tidalImage = (uuid: string | undefined | null, size: number) => (uuid ? `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg` : undefined)

const artistsOf = (item: Raw) =>
  ((item.artists?.length ? item.artists : [item.artist]).filter(Boolean) as Raw[]).map((artist) => ({ id: artist.id ? tidalArtistId(artist.id) : undefined, name: artist.name }))

export function toTidalSong(item: Raw, album?: Raw): Song {
  const parent = item.album ?? album
  return {
    type: 'song',
    source: SOURCE,
    id: tidalId(item.id, item.isrc),
    title: item.version ? `${item.title} (${item.version})` : item.title,
    artists: artistsOf(item),
    album: parent?.id ? { id: tidalAlbumId(parent.id), name: parent.title ?? '' } : undefined,
    duration: item.duration,
    thumbnail: tidalImage(parent?.cover, 320),
    explicit: Boolean(item.explicit),
  }
}

export function toTidalAlbum(album: Raw): Album {
  return {
    type: 'album',
    source: SOURCE,
    id: tidalAlbumId(album.id),
    title: album.title,
    artists: artistsOf(album),
    year: album.releaseDate?.slice(0, 4),
    thumbnail: tidalImage(album.cover, 640),
    explicit: Boolean(album.explicit),
    kind: album.type ? album.type.charAt(0) + album.type.slice(1).toLowerCase() : 'Album',
  }
}

export function toTidalArtist(artist: Raw): Artist {
  return { type: 'artist', source: SOURCE, id: tidalArtistId(artist.id), name: artist.name, thumbnail: tidalImage(artist.picture, 480) }
}

const items = (body: Raw, key?: string) => ((key ? body.data?.[key] : body.data)?.items ?? []) as Raw[]

export async function tidalSearch(query: string, type: string): Promise<Item[]> {
  const q = encodeURIComponent(query)
  if (type === 'song') return items(await call<Raw>('hifi', `/search/?s=${q}`)).map((item) => toTidalSong(item))
  if (type === 'album') return items(await call<Raw>('hifi', `/search/?al=${q}`), 'albums').map(toTidalAlbum)
  if (type === 'artist') return items(await call<Raw>('hifi', `/search/?a=${q}`), 'artists').map(toTidalArtist)
  return []
}

/** "All": songs, albums and artists, searched side by side (each kind is its own request). */
export async function tidalSearchAll(query: string): Promise<{ songs: Song[]; albums: Album[]; artists: Artist[] }> {
  const settle = <T>(promise: Promise<T[]>) => promise.catch(() => [] as T[])
  const [songs, albums, artists] = await Promise.all([
    settle(tidalSearch(query, 'song') as Promise<Song[]>),
    settle(tidalSearch(query, 'album') as Promise<Album[]>),
    settle(tidalSearch(query, 'artist') as Promise<Artist[]>),
  ])
  return { songs, albums, artists }
}

export async function tidalAlbum(id: string): Promise<CollectionPage> {
  const data = (await call<Raw>('hifi', `/album/?id=${after(id, 'tidal-album')}`)).data ?? {}
  const album = toTidalAlbum(data)
  return {
    id,
    kind: 'album',
    title: data.title,
    subtitle: [album.kind, album.year, data.numberOfTracks ? `${data.numberOfTracks} songs` : ''].filter(Boolean).join(' • '),
    secondSubtitle: 'TIDAL • Lossless',
    thumbnail: album.thumbnail,
    artists: album.artists,
    year: album.year,
    songs: (data.items ?? []).map((entry: Raw) => entry.item ?? entry).filter((item: Raw) => item?.id && item.title).map((item: Raw) => toTidalSong(item, data)),
    hasMore: false,
    sections: [],
  }
}

export async function tidalArtist(id: string): Promise<ArtistPage> {
  const artist = after(id, 'tidal-artist')
  const [profile, discography] = await Promise.all([call<Raw>('hifi', `/artist/?id=${artist}`), call<Raw>('hifi', `/artist/?f=${artist}&skip_tracks=true`).catch(() => null)])
  const info = profile.artist ?? {}
  const albums = ((discography?.albums?.items ?? []) as Raw[]).map(toTidalAlbum)
  const top = ((discography?.tracks?.items ?? discography?.tracks ?? []) as Raw[]).filter((item) => item?.id).map((item) => toTidalSong(item))
  const section = (sectionId: string, title: string, list: Item[], layout: 'list' | 'carousel' = 'carousel') => (list.length ? [{ id: sectionId, title, items: list, layout }] : [])
  return {
    id,
    name: info.name,
    thumbnail: tidalImage(info.picture, 750),
    shuffle: { playlistId: `tidal-artist-shuffle:${artist}` },
    sections: [
      ...section('top', 'Top songs', top.slice(0, 10), 'list'),
      ...section('albums', 'Albums', albums.filter((album) => album.kind === 'Album')),
      ...section('singles', 'Singles and EPs', albums.filter((album) => album.kind !== 'Album')),
    ],
  }
}

/** Every song on an artist's albums, for shuffle and radio (a few albums: one request each). */
export async function tidalArtistSongs(artist: string): Promise<Song[]> {
  const discography = await call<Raw>('hifi', `/artist/?f=${artist}&skip_tracks=true`)
  const albums = ((discography.albums?.items ?? []) as Raw[]).sort(() => Math.random() - 0.5).slice(0, 4)
  const pages = await Promise.all(albums.map((album) => tidalAlbum(tidalAlbumId(album.id)).catch(() => null)))
  return pages.flatMap((page) => page?.songs ?? [])
}

/** The FLAC URL in a /track/ manifest: base64 JSON { mimeType, urls } (or a DASH MPD, which this can't play). */
function manifestUrl(manifest: string): { url: string; mimeType: string } | null {
  let decoded = manifest
  try {
    decoded = atob(manifest)
  } catch {
    /* not base64 */
  }
  if (decoded.includes('<MPD')) return null
  try {
    const parsed = JSON.parse(decoded)
    const url = parsed?.urls?.[0]
    return url ? { url, mimeType: parsed.mimeType ?? 'audio/flac' } : null
  } catch {
    const url = /https?:\/\/[^\s"'<>]+/.exec(decoded)?.[0]
    return url ? { url, mimeType: 'audio/flac' } : null
  }
}

export async function tidalStream(song: Song): Promise<StreamInfo> {
  const id = song.id.split(':')[2]
  const body = await call<Raw>('hifi', `/track/?id=${id}&quality=LOSSLESS`)
  const info = body.data ?? body
  const found = typeof info.manifest === 'string' ? manifestUrl(info.manifest) : null
  const url = found?.url ?? info.OriginalTrackUrl ?? info.originalTrackUrl
  if (!url) throw new StreamError('The hifi-api instance had no lossless stream for this track')
  const bits = info.bitDepth && info.sampleRate ? info.bitDepth * info.sampleRate * 2 : 0
  return { url, mimeType: found?.mimeType ?? 'audio/flac', bitrate: bits, expiresAt: Date.now() + 30 * 60_000 }
}
