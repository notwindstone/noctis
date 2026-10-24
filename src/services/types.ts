import type {
  AccountInfo,
  Album,
  Artist,
  ArtistPage,
  BrowseTarget,
  CollectionPage,
  HomeResult,
  Item,
  Playlist,
  QueuePage,
  SearchFilter,
  SearchResult,
  SearchType,
  Section,
  Song,
  StreamInfo,
  Suggestions,
} from '../models'

/**
 * A service: everything Noctis needs from a streaming backend, grouped by area.
 *
 * Every endpoint takes a single input object and returns a promise. Only `name` is
 * required: leave out what a service can't do and the app hides or disables the
 * features that need it. Items a service returns should carry `source: <service id>`;
 * the app then routes everything about those items (pages, queues, streams, likes,
 * links) back to the same service.
 *
 * Which service answers:
 * - item-based calls (an album, a song's stream, a queue continuation…) go to the
 *   item's `source`;
 * - home, search and the account library go to the service chosen in
 *   Settings → Content (`activeServiceId`), or the one passed explicitly.
 *
 * Every call also passes through one hook, `onRequest` (see src/services/api.ts).
 */
export interface ServiceDefinition {
  /** Shown in settings and messages: "YouTube Music". */
  name: string
  /** Icon name (see src/icons.ts, or one added with registerIcon). */
  icon?: string

  home?: {
    load(input: { filter: string | null }): Promise<HomeResult>
    more?(input: { filter: string | null }): Promise<{ sections: Section[]; hasMore: boolean }>
  }

  search?: {
    /** Filter chips; "all" (sections) is always offered first. */
    filters?: SearchFilter[]
    query(input: { query: string; type: SearchType }): Promise<SearchResult>
    /** The next page of the last filtered search. */
    more?(input: { query: string; type: SearchType }): Promise<{ items: Item[]; hasMore: boolean }>
    suggestions?(input: { input: string }): Promise<Suggestions>
  }

  albums?: {
    get(input: { id: string }): Promise<CollectionPage>
  }

  playlists?: {
    get(input: { id: string }): Promise<CollectionPage>
    more?(input: { id: string }): Promise<{ songs: Song[]; hasMore: boolean }>
  }

  artists?: {
    get(input: { id: string }): Promise<ArtistPage>
  }

  /** Pages behind a section's "More" (`Section.more`). */
  browse?: {
    get(input: { target: BrowseTarget }): Promise<{ title: string; sections: Section[] }>
  }

  queue?: {
    /** A queue from an opaque playlist (mixes on home, an artist's shuffle/radio). */
    start?(input: { playlistId?: string; videoId?: string; params?: string }): Promise<QueuePage>
    /** Extend a queue with the `continuation` its last page returned. */
    more?(input: { continuation: string; playlistId?: string }): Promise<QueuePage>
    /** Endless "radio" from a song, an album or a playlist. */
    radio?(input: RadioSeed): Promise<QueuePage>
  }

  library?: {
    playlists?(input: object): Promise<Playlist[]>
    artists?(input: object): Promise<Artist[]>
    /** Liked songs as the service has them (merged with likes made on the device). */
    liked?(input: object): Promise<{ songs: Song[]; hasMore: boolean }>
    likedMore?(input: object): Promise<{ songs: Song[]; hasMore: boolean }>
    /** Mirror a like made in the app. */
    like?(input: { song: Song; liked: boolean }): Promise<void>
  }

  streams?: {
    /** A playable URL. `efficient` asks for a small stream (data saver, slow network). */
    resolve(input: { song: Song; efficient: boolean }): Promise<StreamInfo>
  }

  /** Synchronous helpers, called while rendering; keep them cheap. */
  links?: {
    /** A link to share; empty or undefined hides "Copy link". */
    share?(item: Item): string | undefined
  }
  thumbnails?: {
    /** The artwork URL resized for `size` px, or undefined if the URL isn't this service's. */
    resize(url: string, size: number): string | undefined
  }

  account?: ServiceAccount
}

/**
 * The signed-in state of a service. Plain fields are fine; use getters for live values
 * (as with settings rows) so the UI updates without the object being replaced.
 */
export interface ServiceAccount {
  readonly signedIn: boolean
  readonly info: AccountInfo | null
  /**
   * Changes whenever content would come out different (another account, language,
   * region…). Screens refetch when it changes, and cached pages are tied to it.
   */
  readonly sessionKey: string
  /** Settings section (see defineSection) where the account is managed. */
  readonly section?: string
  /** "Sign in to YouTube Music", on the settings account card. */
  readonly signInTitle?: string
  readonly signInDescription?: string
  /** Re-read the account's name and picture. */
  refresh?(): Promise<unknown>
}

export type RadioSeed =
  | { kind: 'song'; song: Song }
  | { kind: 'album'; album: Pick<Album, 'id' | 'title'>; playlistId?: string }
  | { kind: 'playlist'; playlist: Pick<Playlist, 'id' | 'title'> }

/** "albums.get", "streams.resolve"… */
export type EndpointName = {
  [Area in keyof ServiceDefinition]-?: NonNullable<ServiceDefinition[Area]> extends infer Group
    ? Group extends object
      ? {
          [Method in keyof Group]-?: NonNullable<Group[Method]> extends (input: never) => Promise<unknown>
            ? `${Area & string}.${Method & string}`
            : never
        }[keyof Group]
      : never
    : never
}[keyof ServiceDefinition]

type AreaOf<E extends EndpointName> = E extends `${infer Area}.${string}` ? Area : never
type MethodOf<E extends EndpointName> = E extends `${string}.${infer Method}` ? Method : never
type EndpointFn<E extends EndpointName> = NonNullable<
  NonNullable<ServiceDefinition[AreaOf<E> & keyof ServiceDefinition]>[MethodOf<E> &
    keyof NonNullable<ServiceDefinition[AreaOf<E> & keyof ServiceDefinition]>]
>

export type EndpointInput<E extends EndpointName> = EndpointFn<E> extends (input: infer I) => unknown ? I : never
export type EndpointResult<E extends EndpointName> = EndpointFn<E> extends (input: never) => Promise<infer R> ? R : never
