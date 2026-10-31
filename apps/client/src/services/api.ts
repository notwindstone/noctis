import { LOCAL_PLAYLISTS, localPlaylistPage } from '../playlists'
import {
  sourceOf,
  type Artist,
  type ArtistPage,
  type BrowseTarget,
  type CollectionPage,
  type HomeResult,
  type Item,
  type Playlist,
  type QueuePage,
  type SearchResult,
  type SearchType,
  type Section,
  type Song,
  type Suggestions,
} from '../models'
import { hooks, runHooks } from '../plugins/hooks'
import { activeService, servicesReady, services } from './registry'
import type { Chapter, EndpointInput, EndpointName, EndpointResult, RadioSeed, ServiceDefinition } from './types'

/**
 * What screens and the player call. Each function picks a service and an endpoint and
 * goes through `request`, the single place where calls reach services (and the
 * `onRequest` hook).
 */

export class ServiceError extends Error {}

/** Which endpoint a service lacks, in words, for error messages. */
const WHAT: Partial<Record<EndpointName, string>> = {
  'home.load': 'a home feed',
  'search.query': 'search',
  'albums.get': 'albums',
  'playlists.get': 'playlists',
  'artists.get': 'artist pages',
  'browse.get': 'this page',
  'streams.resolve': 'playback',
  'queue.start': 'this mix',
  'library.playlists': 'library playlists',
  'library.artists': 'library artists',
}

function serviceName(id: string): string {
  return services[id]?.name ?? id
}

function endpointOf(service: ServiceDefinition | undefined, endpoint: string) {
  const [area, method] = endpoint.split('.') as [keyof ServiceDefinition, string]
  const group = service?.[area] as Record<string, unknown> | undefined
  const fn = group?.[method]
  return typeof fn === 'function' ? (fn as (input: unknown) => Promise<unknown>).bind(group) : null
}

/** Whether `service` (an id) can answer `endpoint`. */
export function supports(service: string | undefined, endpoint: EndpointName): boolean {
  return service !== undefined && endpointOf(services[service], endpoint) !== null
}

export interface RequestContext<E extends EndpointName = EndpointName> {
  service: string
  endpoint: E
  input: EndpointInput<E>
  result?: EndpointResult<E>
}

/** Call `endpoint` on `service`, through the `onRequest` hook. */
export async function request<E extends EndpointName>(service: string, endpoint: E, input: EndpointInput<E>): Promise<EndpointResult<E>> {
  await servicesReady()
  const point = hooks.onRequest
  const context: RequestContext<E> = { service, endpoint, input }

  if (point.before.length > 0) {
    const before = await runHooks<EndpointResult<E>>('onRequest', 'before', context)
    if (before.stopped) return before.response
  }

  // Hooks may have rerouted the call.
  const fn = endpointOf(services[context.service], context.endpoint)
  if (!fn) {
    if (!services[context.service]) throw new ServiceError(`Nothing provides content from "${context.service}". Is its plugin enabled?`)
    throw new ServiceError(`${serviceName(context.service)} doesn't support ${WHAT[context.endpoint] ?? context.endpoint}.`)
  }
  const result = (await fn(context.input)) as EndpointResult<E>

  if (point.after.length > 0) {
    context.result = result
    const after = await runHooks<EndpointResult<E>>('onRequest', 'after', context)
    if (after.stopped) return after.response
    return context.result
  }
  return result
}

/** The active service's id, or an error saying there's none. */
async function active(): Promise<string> {
  await servicesReady()
  const current = activeService.value
  if (!current) throw new ServiceError('No streaming service is enabled. Turn one on in Settings → Plugins.')
  return current.id
}

/* ------------------------------------------------------------------ *
 * Home and search (the active service, unless one is given)
 * ------------------------------------------------------------------ */

export async function loadHome(filter: string | null = null, service?: string): Promise<HomeResult> {
  return request(service ?? (await active()), 'home.load', { filter })
}

export async function loadMoreHome(filter: string | null = null, service?: string): Promise<{ sections: Section[]; hasMore: boolean }> {
  const id = service ?? (await active())
  if (!supports(id, 'home.more')) return { sections: [], hasMore: false }
  return request(id, 'home.more', { filter })
}

let lastSearch: { query: string; type: SearchType; service: string } | null = null

export async function search(query: string, type: SearchType, service?: string): Promise<SearchResult> {
  const id = service ?? (await active())
  lastSearch = { query, type, service: id }
  return request(id, 'search.query', { query, type })
}

/** The next page of the last search. */
export async function searchMore(): Promise<{ items: Item[]; hasMore: boolean }> {
  if (!lastSearch || !supports(lastSearch.service, 'search.more')) return { items: [], hasMore: false }
  const { service, query, type } = lastSearch
  return request(service, 'search.more', { query, type })
}

export async function searchSuggestions(input: string, service?: string): Promise<Suggestions> {
  const id = service ?? (await active())
  if (!supports(id, 'search.suggestions')) return { queries: [], items: [] }
  return request(id, 'search.suggestions', { input })
}

/* ------------------------------------------------------------------ *
 * Pages (the item's own service)
 * ------------------------------------------------------------------ */

export function getAlbum(id: string, source?: string): Promise<CollectionPage> {
  return request(sourceOf({ source }), 'albums.get', { id })
}

export function getPlaylist(id: string, source?: string): Promise<CollectionPage> {
  // Playlists kept on this device aren't any service's.
  if (source === LOCAL_PLAYLISTS) return Promise.resolve().then(() => localPlaylistPage(id))
  return request(sourceOf({ source }), 'playlists.get', { id })
}

export async function loadMorePlaylist(id: string, source?: string): Promise<{ songs: Song[]; hasMore: boolean }> {
  if (source === LOCAL_PLAYLISTS) return { songs: [], hasMore: false }
  const service = sourceOf({ source })
  if (!supports(service, 'playlists.more')) return { songs: [], hasMore: false }
  return request(service, 'playlists.more', { id })
}

export function getArtist(id: string, source?: string): Promise<ArtistPage> {
  return request(sourceOf({ source }), 'artists.get', { id })
}

export function browse(target: BrowseTarget): Promise<{ title: string; sections: Section[] }> {
  return request(sourceOf(target), 'browse.get', { target })
}

/* ------------------------------------------------------------------ *
 * Queues
 * ------------------------------------------------------------------ */

const EMPTY_QUEUE: QueuePage = { songs: [] }

export function startQueue(options: { playlistId?: string; videoId?: string; params?: string }, source?: string): Promise<QueuePage> {
  return request(sourceOf({ source }), 'queue.start', options)
}

export async function queueMore(continuation: string, playlistId: string | undefined, source?: string): Promise<QueuePage> {
  const service = sourceOf({ source })
  if (!supports(service, 'queue.more')) return EMPTY_QUEUE
  return request(service, 'queue.more', { continuation, playlistId })
}

/** Chapters of a song, if its service knows any (none otherwise, and when asking fails). */
export async function getChapters(song: Song): Promise<Chapter[]> {
  const service = sourceOf(song)
  if (!supports(service, 'chapters.get')) return []
  return request(service, 'chapters.get', { song })
}

/** A radio from a song, album or playlist; empty when its service has no radios. */
export async function radio(seed: RadioSeed, source?: string): Promise<QueuePage> {
  const service = sourceOf({ source: source ?? (seed.kind === 'song' ? seed.song.source : undefined) })
  if (!supports(service, 'queue.radio')) return EMPTY_QUEUE
  return request(service, 'queue.radio', seed)
}

export function radioFor(song: Song): Promise<QueuePage> {
  return radio({ kind: 'song', song })
}

/* ------------------------------------------------------------------ *
 * Library (the active service)
 * ------------------------------------------------------------------ */

export async function getLibraryPlaylists(): Promise<Playlist[]> {
  const id = await active()
  return supports(id, 'library.playlists') ? request(id, 'library.playlists', {}) : []
}

export async function getLibraryArtists(): Promise<Artist[]> {
  const id = await active()
  return supports(id, 'library.artists') ? request(id, 'library.artists', {}) : []
}

/** Liked songs from the service; null when it doesn't keep any. */
export async function getLikedSongs(): Promise<{ songs: Song[]; hasMore: boolean } | null> {
  const id = await active()
  return supports(id, 'library.liked') ? request(id, 'library.liked', {}) : null
}

export async function loadMoreLikedSongs(): Promise<{ songs: Song[]; hasMore: boolean }> {
  const id = await active()
  return supports(id, 'library.likedMore') ? request(id, 'library.likedMore', {}) : { songs: [], hasMore: false }
}

/** Mirror a like to the song's service, if it takes likes. */
export async function setLiked(song: Song, liked: boolean): Promise<boolean> {
  const service = sourceOf(song)
  if (!supports(service, 'library.like')) return false
  await request(service, 'library.like', { song, liked })
  return true
}

/* ------------------------------------------------------------------ *
 * Synchronous helpers (no hook: they run while rendering)
 * ------------------------------------------------------------------ */

export function shareLink(item: Item): string {
  try {
    return services[sourceOf(item)]?.links?.share?.(item) ?? ''
  } catch {
    return ''
  }
}

export function searchFilters(service?: string) {
  const id = service ?? activeService.value?.id
  const filters = (id && services[id]?.search?.filters) || []
  return [{ id: 'all', label: 'All' }, ...filters.filter((filter) => filter.id !== 'all')]
}
