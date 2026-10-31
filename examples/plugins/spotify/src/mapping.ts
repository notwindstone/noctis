import type { Album, Artist, Item, Playlist, Song } from './host'
import type { Raw } from './api'

/**
 * Mapping. GraphQL wraps entities in data/item/itemV2/content/track; every entity
 * has a URI ("spotify:track:…"), used as the Noctis id as it is.
 */

export const typeOf = (uri: string) => String(uri ?? '').split(':')[1]
export const compact = <T>(list: (T | null | undefined)[]): T[] => list.filter((entry): entry is T => Boolean(entry))

/** The entity inside a wrapper, or null. */
export function unwrap(node: Raw | null | undefined): Raw | null {
  let current = node
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    if (current._uri && current.data && !current.data.uri) return { ...current.data, uri: current._uri }
    const inner = current.data ?? current.content ?? current.itemV2 ?? current.item ?? current.track
    if (inner && typeof inner === 'object') {
      current = inner
      continue
    }
    break
  }
  return current?.uri ? current : null
}

export function largest(sources: Raw[] | undefined | null): string | undefined {
  if (!sources?.length) return undefined
  return [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url
}

export const imageOf = (entity: Raw | null | undefined): string | undefined =>
  largest(entity?.coverArt?.sources) ??
  largest(entity?.visuals?.avatarImage?.sources) ??
  largest(entity?.images?.items?.[0]?.sources) ??
  largest(entity?.albumOfTrack?.coverArt?.sources)

export const artistRefs = (artists: Raw | undefined): { id?: string; name: string }[] =>
  (artists?.items ?? [])
    .map((artist: Raw) => ({ id: artist.uri, name: artist.profile?.name ?? artist.name ?? '' }))
    .filter((artist: { id?: string; name: string }) => artist.name)

export const yearOf = (date: Raw | undefined) => (date?.year ? String(date.year) : (date?.isoString?.slice(0, 4) as string | undefined))
export const KIND: Record<string, string> = { ALBUM: 'Album', SINGLE: 'Single', EP: 'EP', COMPILATION: 'Compilation' }

export function formatCount(value: Raw | number): string {
  const number = Number(value)
  if (!number) return ''
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}K`
  return String(number)
}

export const plainText = (html: string | undefined): string | undefined =>
  html ? new DOMParser().parseFromString(html.replace(/<[^>]+>/g, ''), 'text/html').documentElement.textContent?.trim() || undefined : undefined

export function toSong(track: Raw | null, album?: Raw): Song | null {
  if (!track || typeOf(track.uri) !== 'track') return null
  const owner = track.albumOfTrack ?? album
  const ms = track.duration?.totalMilliseconds ?? track.trackDuration?.totalMilliseconds
  return {
    type: 'song',
    source: 'spotify',
    id: String(track.uri),
    title: String(track.name ?? ''),
    artists: artistRefs(track.artists ?? track.firstArtist),
    album: owner?.uri ? { id: String(owner.uri), name: String(owner.name ?? '') } : undefined,
    duration: ms ? Math.round(Number(ms) / 1000) : undefined,
    thumbnail: imageOf(owner) ?? imageOf(track),
    explicit: track.contentRating?.label === 'EXPLICIT' || undefined,
  }
}

export function toAlbum(album: Raw | null): Album | null {
  if (!album || typeOf(album.uri) !== 'album') return null
  return {
    type: 'album',
    source: 'spotify',
    id: String(album.uri),
    title: String(album.name ?? ''),
    artists: artistRefs(album.artists),
    year: yearOf(album.date),
    thumbnail: imageOf(album),
    kind: KIND[album.type] ?? 'Album',
  }
}

export function toArtist(artist: Raw | null): Artist | null {
  if (!artist || typeOf(artist.uri) !== 'artist') return null
  return {
    type: 'artist',
    source: 'spotify',
    id: String(artist.uri),
    name: String(artist.profile?.name ?? artist.name ?? ''),
    subtitle: 'Artist',
    thumbnail: imageOf(artist),
  }
}

export function toPlaylist(playlist: Raw | null): Playlist | null {
  if (!playlist || typeOf(playlist.uri) !== 'playlist') return null
  const owner = playlist.ownerV2?.data?.name
  return {
    type: 'playlist',
    source: 'spotify',
    id: String(playlist.uri),
    title: String(playlist.name ?? ''),
    subtitle: owner ? `Playlist • ${owner}` : 'Playlist',
    thumbnail: imageOf(playlist),
  }
}

/** Any wrapped entity → a Noctis item. */
export function toItem(node: Raw | null | undefined): Item | null {
  const entity = unwrap(node)
  switch (typeOf(entity?.uri ?? '')) {
    case 'track':
      return toSong(entity)
    case 'album':
      return toAlbum(entity)
    case 'artist':
      return toArtist(entity)
    case 'playlist':
      return toPlaylist(entity)
  }
  return null
}

export const toItems = (nodes: Raw[] | undefined | null): Item[] => compact((nodes ?? []).map((node) => toItem(node)))
