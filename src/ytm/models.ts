/**
 * Plain, serialisable models the UI works with. Everything from youtubei.js is mapped
 * into these in src/ytm/parse.ts, so components never touch InnerTube node classes and
 * songs can be stored as-is in the local library.
 */

export interface ArtistRef {
  id?: string
  name: string
}

export interface AlbumRef {
  id: string
  name: string
}

export interface Song {
  type: 'song'
  /** YouTube video id. */
  id: string
  title: string
  artists: ArtistRef[]
  album?: AlbumRef
  /** Seconds. */
  duration?: number
  thumbnail?: string
  explicit?: boolean
  /** A music video (16:9 artwork) rather than an audio track. */
  isVideo?: boolean
}

export interface Album {
  type: 'album'
  /** Browse id, e.g. MPREb_… */
  id: string
  title: string
  artists: ArtistRef[]
  year?: string
  thumbnail?: string
  explicit?: boolean
  /** "Album", "Single", "EP"… */
  kind?: string
}

export interface Playlist {
  type: 'playlist'
  /** Playlist id without the VL browse prefix. */
  id: string
  title: string
  subtitle?: string
  thumbnail?: string
  /**
   * Mixes and radios can only be played, not browsed. They carry the video id the
   * radio is seeded from, if any.
   */
  radio?: { videoId?: string; params?: string }
}

export interface Artist {
  type: 'artist'
  /** Channel id, e.g. UC… */
  id: string
  name: string
  subtitle?: string
  thumbnail?: string
}

export type Item = Song | Album | Playlist | Artist

export interface BrowseTarget {
  browseId: string
  params?: string
}

export interface Section {
  id: string
  title: string
  strapline?: string
  /** Small header artwork, e.g. the artist in "Similar to …" rows. */
  thumbnail?: string
  /** The header thumbnail is an artist avatar (render it round). */
  thumbnailRound?: boolean
  /** 'quick-picks' renders songs as a horizontally paged list grid, like YouTube Music. */
  layout: 'quick-picks' | 'carousel' | 'list'
  items: Item[]
  more?: BrowseTarget
}

export interface CollectionPage {
  id: string
  kind: 'album' | 'playlist'
  title: string
  subtitle?: string
  secondSubtitle?: string
  description?: string
  thumbnail?: string
  artists: ArtistRef[]
  year?: string
  songs: Song[]
  /** Opaque continuation handle; pass it back to load more songs. */
  hasMore: boolean
  /** The playlist behind an album, used for radio/shuffle. */
  playlistId?: string
  /** Albums and playlists the page links to ("More from …", "Related"). */
  sections: Section[]
}

export interface ArtistPage {
  id: string
  name: string
  description?: string
  subscribers?: string
  thumbnail?: string
  shuffle?: { playlistId: string; params?: string }
  radio?: { playlistId: string; params?: string }
  sections: Section[]
}

export interface AccountInfo {
  name: string
  handle?: string
  photo?: string
}

export function artistNames(artists: ArtistRef[] | undefined): string {
  return (artists ?? []).map((artist) => artist.name).join(', ')
}

export function itemKey(item: Item): string {
  return `${item.type}:${item.id}`
}
