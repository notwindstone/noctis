/**
 * Plain, serialisable models the UI works with. Services (src/services) map whatever
 * their backend returns into these, so components never see a service's own types and
 * songs can be stored as-is in the local library.
 */

/**
 * Which service an item comes from: the id it was defined with (`defineService`).
 * Services other than YouTube Music should prefix their ids ("spotify:4uLU6hMC…") so
 * they never collide in the library, downloads or the queue.
 *
 * Items without a `source` are YouTube Music's: that's what the app saved before it
 * had services, and what the YouTube Music service still produces.
 */
export const DEFAULT_SOURCE = 'youtube-music'

export function sourceOf(item: { source?: string } | null | undefined): string {
  return item?.source ?? DEFAULT_SOURCE
}

export interface ArtistRef {
  id?: string
  name: string
}

export interface AlbumRef {
  id: string
  name: string
}

/**
 * Length from which a "song" is a station: a placeholder (some services list live radio streams
 * as tracks, with lengths like 289 hours) that plays a few seconds of real audio and then ends.
 * Noctis skips them and never downloads them.
 */
export const STATION_SECONDS = 12 * 3600
export const isStation = (song: Pick<Song, 'duration'>) => (song.duration ?? 0) >= STATION_SECONDS

export interface Song {
  type: 'song'
  /** Service id; undefined = YouTube Music. */
  source?: string
  /** Unique within its service (a YouTube video id for YouTube Music). */
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
  /** Times played / viewed, when the service tells (it enables "Most played" when sorting a list). */
  plays?: number
}

export interface Album {
  type: 'album'
  /** Service id; undefined = YouTube Music. */
  source?: string
  /** YouTube Music: a browse id, e.g. MPREb_… */
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
  /** Service id; undefined = YouTube Music. */
  source?: string
  /** YouTube Music: the playlist id without the VL browse prefix. */
  id: string
  title: string
  subtitle?: string
  thumbnail?: string
  /**
   * Mixes and radios can only be played, not browsed. They carry the video id the
   * radio is seeded from, if any.
   */
  radio?: { videoId?: string; params?: string }
  /** Yours to change: songs can be added and removed, and it can be renamed and deleted (see src/playlists.ts). */
  editable?: boolean
}

export interface Artist {
  type: 'artist'
  /** Service id; undefined = YouTube Music. */
  source?: string
  /** YouTube Music: a channel id, e.g. UC… */
  id: string
  name: string
  subtitle?: string
  thumbnail?: string
}

export type Item = Song | Album | Playlist | Artist

/** An opaque link to a page of sections (e.g. "More" on a row), resolved by its service. */
export interface BrowseTarget {
  browseId: string
  params?: string
  /** Service id; undefined = YouTube Music. */
  source?: string
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
  /** A playlist of yours: songs can be removed from it here. */
  editable?: boolean
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

/* ------------------------------------------------------------------ *
 * What service endpoints return (see src/services/types.ts)
 * ------------------------------------------------------------------ */

export interface HomeResult {
  sections: Section[]
  /** Chips above the feed ("Relax", "Workout"…); the selected one is passed back. */
  filters: string[]
  selectedFilter: string | null
  hasMore: boolean
}

/** A search filter id: "all" plus whatever a service lists in `search.filters`. */
export type SearchType = string

export interface SearchFilter {
  id: SearchType
  label: string
}

export interface SearchResult {
  /** For "all": a top result followed by one section per category. */
  sections: Section[]
  /** For a filtered search: a flat list. */
  items: Item[]
  hasMore: boolean
  correctedQuery?: string
}

export interface Suggestions {
  queries: string[]
  items: Item[]
}

export interface QueuePage {
  songs: Song[]
  /** Opaque; passed back to `queue.more` to extend the queue. */
  continuation?: string
  playlistId?: string
}

export interface StreamInfo {
  /** Anything an <audio> element plays: https:, blob:, data:… */
  url: string
  /** Downloads use it to pick a file extension. */
  mimeType: string
  bitrate: number
  /** Sampling rate in Hz, when the service says (shown with the format in the player). */
  sampleRate?: number
  /** Needed to download (files are fetched in byte ranges). */
  contentLength?: number
  /** Normalisation hint in dB relative to the reference loudness. */
  loudnessDb?: number
  /** When `url` stops working (ms since the epoch). */
  expiresAt: number
  /** URL for ranged download requests, if not `url` (e.g. through a proxy). */
  fetchUrl?: string
  /** Extra headers for ranged download requests on a device. */
  fetchHeaders?: Record<string, string>
  /** The service says this is a live stream or a station (no end, nothing to save). */
  live?: boolean
  /** Length in seconds as the service reports it for this stream, when the song itself didn't say. */
  duration?: number
  /**
   * Content decryption (Widevine DRM and the like): the player attaches MediaKeys and
   * answers the CDM's challenge by POSTing it to `licenseUrl`. Streams with this set
   * can't be downloaded — the bytes only exist decrypted in the CDM.
   */
  drm?: {
    /** Key system identifier, e.g. "com.widevine.alpha". */
    system: string
    /** Base64 init data (the service's PSSH box) to open the session with. */
    initData: string
    /** Where the CDM's challenge is POSTed; the answer goes into the session. */
    licenseUrl: string
    /** Extra headers for the license request (usually the service's auth). */
    licenseHeaders?: Record<string, string>
    /** Server certificate URL, when the service expects one in the challenge. */
    certificateUrl?: string
    /** Media types the key system must support; defaults to AAC in MP4. */
    codecs?: string[]
  }
}
