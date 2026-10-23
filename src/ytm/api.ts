import {
  GridContinuation,
  MusicShelfContinuation,
  PlaylistPanelContinuation,
  YTNodes,
  type Helpers,
  type YTMusic,
} from 'youtubei.js'
import { innertube } from './client'
import type { ArtistPage, ArtistRef, BrowseTarget, CollectionPage, Item, Section, Song } from './models'
import { fromNode, itemsOf, payloadOf, sectionsOf, songsOf, stripBrowsePrefix } from './parse'
import { largest } from './thumbnails'

type YTNode = Helpers.YTNode

interface TextLike {
  toString(): string
  runs?: { text: string; endpoint?: { payload?: unknown } }[]
}

function textOf(value: TextLike | null | undefined): string {
  const text = value?.toString() ?? ''
  return text === 'N/A' ? '' : text
}

function artistRefsFromText(text: TextLike | null | undefined): ArtistRef[] {
  return (text?.runs ?? [])
    .filter((run) => payloadOf(run.endpoint).browseId?.startsWith('UC'))
    .map((run) => ({ name: run.text, id: payloadOf(run.endpoint).browseId }))
}

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */

export interface HomeResult {
  sections: Section[]
  filters: string[]
  selectedFilter: string | null
  hasMore: boolean
}

let homeFeed: YTMusic.HomeFeed | null = null
let homeFilters: string[] = []

function homeSections(feed: YTMusic.HomeFeed): Section[] {
  return sectionsOf((feed.sections ?? []).filter((section) => section.is(YTNodes.MusicCarouselShelf)))
}

export async function loadHome(filter: string | null = null): Promise<HomeResult> {
  const yt = await innertube()
  let feed = await yt.music.getHomeFeed()
  homeFilters = feed.filters

  if (filter && homeFilters.includes(filter)) {
    feed = await feed.applyFilter(filter)
  }

  homeFeed = feed
  return {
    sections: homeSections(feed),
    filters: homeFilters,
    selectedFilter: filter && homeFilters.includes(filter) ? filter : null,
    hasMore: feed.has_continuation,
  }
}

export async function loadMoreHome(): Promise<{ sections: Section[]; hasMore: boolean }> {
  if (!homeFeed?.has_continuation) return { sections: [], hasMore: false }
  homeFeed = await homeFeed.getContinuation()
  return { sections: homeSections(homeFeed), hasMore: homeFeed.has_continuation }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export type SearchType = 'all' | 'song' | 'video' | 'album' | 'playlist' | 'artist'

export interface SearchResult {
  /** For 'all': a top result followed by one section per category. */
  sections: Section[]
  /** For a filtered search: a flat list. */
  items: Item[]
  hasMore: boolean
  correctedQuery?: string
}

type SearchContinuation = Awaited<ReturnType<YTMusic.Search['getContinuation']>>
let searchState: YTMusic.Search | SearchContinuation | null = null

function topResult(card: YTNodes.MusicCardShelf): Item | null {
  const payload = payloadOf(card.on_tap)
  const title = textOf(card.title)
  const subtitle = textOf(card.subtitle)
  const thumbnail = largest(card.thumbnail?.contents)
  const browseId = payload.browseId ?? ''

  if (payload.videoId) {
    return {
      type: 'song',
      id: payload.videoId,
      title,
      artists: artistRefsFromText(card.subtitle),
      thumbnail,
      isVideo: !/^song/i.test(subtitle),
    }
  }
  if (browseId.startsWith('UC')) return { type: 'artist', id: browseId, name: title, subtitle, thumbnail }
  if (browseId.startsWith('MPRE')) {
    return { type: 'album', id: browseId, title, artists: artistRefsFromText(card.subtitle), thumbnail, kind: subtitle.split(' • ')[0] }
  }
  if (browseId.startsWith('VL')) return { type: 'playlist', id: stripBrowsePrefix(browseId), title, subtitle, thumbnail }
  return null
}

export async function search(query: string, type: SearchType): Promise<SearchResult> {
  const yt = await innertube()
  const result = await yt.music.search(query, { type })
  searchState = result

  const corrected = textOf(result.did_you_mean?.corrected_query) || textOf(result.showing_results_for?.corrected_query)

  if (type !== 'all') {
    const shelf = result.contents?.find((node) => node.is(YTNodes.MusicShelf))
    const items = shelf?.is(YTNodes.MusicShelf) ? itemsOf(shelf.contents) : []
    return { sections: [], items, hasMore: result.has_continuation, correctedQuery: corrected || undefined }
  }

  const sections: Section[] = []
  // Newer responses list results as single-item sections rather than category shelves.
  const loose: Item[] = []
  for (const node of result.contents ?? []) {
    if (node.is(YTNodes.ItemSection)) {
      loose.push(...itemsOf(node.contents))
    } else if (node.is(YTNodes.MusicCardShelf)) {
      const top = topResult(node)
      const extra = itemsOf(node.contents)
      if (top) sections.push({ id: 'top', title: 'Top result', layout: 'list', items: [top, ...extra] })
    } else if (node.is(YTNodes.MusicShelf)) {
      const items = itemsOf(node.contents)
      if (items.length > 0) sections.push({ id: `shelf-${sections.length}`, title: textOf(node.title), layout: 'list', items })
    }
  }

  if (loose.length > 0) {
    const shown = new Set(sections.flatMap((section) => section.items.map((item) => `${item.type}:${item.id}`)))
    const items = loose.filter((item) => !shown.has(`${item.type}:${item.id}`))
    if (items.length > 0) sections.push({ id: 'results', title: 'Results', layout: 'list', items })
  }

  return { sections, items: [], hasMore: false, correctedQuery: corrected || undefined }
}

export async function searchMore(): Promise<{ items: Item[]; hasMore: boolean }> {
  if (!searchState?.has_continuation) return { items: [], hasMore: false }
  const next = await searchState.getContinuation()
  searchState = next
  return { items: itemsOf(next.contents?.contents), hasMore: next.has_continuation }
}

export interface Suggestions {
  queries: string[]
  items: Item[]
}

export async function searchSuggestions(input: string): Promise<Suggestions> {
  const yt = await innertube()
  const sections = await yt.music.getSearchSuggestions(input)
  const queries: string[] = []
  const items: Item[] = []

  for (const section of sections) {
    for (const node of section.contents) {
      if (node.is(YTNodes.SearchSuggestion)) {
        const text = textOf(node.suggestion)
        if (text) queries.push(text)
      } else {
        const item = fromNode(node)
        if (item) items.push(item)
      }
    }
  }

  return { queries, items }
}

/* ------------------------------------------------------------------ *
 * Albums and playlists
 * ------------------------------------------------------------------ */

function fillSongs(songs: Song[], defaults: Partial<Song>): Song[] {
  return songs.map((song) => ({
    ...song,
    artists: song.artists.length > 0 ? song.artists : (defaults.artists ?? []),
    album: song.album ?? defaults.album,
    thumbnail: song.thumbnail ?? defaults.thumbnail,
  }))
}

function playlistIdFrom(buttons: Iterable<YTNode> | undefined): string | undefined {
  for (const button of buttons ?? []) {
    if (button.is(YTNodes.MusicPlayButton, YTNodes.Button)) {
      const id = payloadOf(button.endpoint).playlistId
      if (id) return id
    }
  }
  return undefined
}

export async function getAlbum(id: string): Promise<CollectionPage> {
  const yt = await innertube()
  const album = await yt.music.getAlbum(id)
  const header = album.header

  let title = ''
  let subtitle = ''
  let secondSubtitle = ''
  let description: string | undefined
  let thumbnail: string | undefined
  let artists: ArtistRef[] = []
  let playlistId: string | undefined

  if (header?.is(YTNodes.MusicResponsiveHeader)) {
    title = textOf(header.title)
    subtitle = textOf(header.subtitle)
    secondSubtitle = textOf(header.second_subtitle)
    description = textOf(header.description?.description) || undefined
    thumbnail = largest(header.thumbnail?.contents)
    artists = artistRefsFromText(header.strapline_text_one)
    if (artists.length === 0 && textOf(header.strapline_text_one)) artists = [{ name: textOf(header.strapline_text_one) }]
    playlistId = playlistIdFrom(header.buttons)
  } else if (header?.is(YTNodes.MusicDetailHeader)) {
    title = textOf(header.title)
    subtitle = textOf(header.subtitle)
    secondSubtitle = textOf(header.second_subtitle)
    description = textOf(header.description) || undefined
    thumbnail = largest(header.thumbnails)
    artists = header.author ? [{ name: header.author.name, id: header.author.channel_id }] : []
  }

  playlistId ??= album.url ? (new URL(album.url).searchParams.get('list') ?? undefined) : undefined
  const year = subtitle.split(' • ').find((part) => /^\d{4}$/.test(part.trim()))

  return {
    id,
    kind: 'album',
    title,
    subtitle,
    secondSubtitle,
    description,
    thumbnail,
    artists,
    year,
    songs: fillSongs(songsOf(album.contents), { artists, thumbnail, album: { id, name: title } }),
    hasMore: false,
    playlistId,
    sections: sectionsOf(album.sections),
  }
}

const playlistPages = new Map<string, YTMusic.Playlist>()

export async function getPlaylist(id: string): Promise<CollectionPage> {
  const yt = await innertube()
  const playlist = await yt.music.getPlaylist(id)
  playlistPages.set(id, playlist)

  let header: YTNode | undefined = playlist.header
  if (header?.is(YTNodes.MusicEditablePlaylistDetailHeader)) header = header.header

  let title = ''
  let subtitle = ''
  let secondSubtitle = ''
  let description: string | undefined
  let thumbnail: string | undefined
  let artists: ArtistRef[] = []

  if (header?.is(YTNodes.MusicResponsiveHeader)) {
    title = textOf(header.title)
    subtitle = textOf(header.subtitle)
    secondSubtitle = textOf(header.second_subtitle)
    description = textOf(header.description?.description) || undefined
    thumbnail = largest(header.thumbnail?.contents)
    artists = artistRefsFromText(header.strapline_text_one)
    if (artists.length === 0 && textOf(header.strapline_text_one)) artists = [{ name: textOf(header.strapline_text_one) }]
  } else if (header?.is(YTNodes.MusicDetailHeader)) {
    title = textOf(header.title)
    subtitle = textOf(header.subtitle)
    secondSubtitle = textOf(header.second_subtitle)
    description = textOf(header.description) || undefined
    thumbnail = largest(header.thumbnails)
    artists = header.author ? [{ name: header.author.name, id: header.author.channel_id }] : []
  }

  return {
    id,
    kind: 'playlist',
    title: title || (id === 'LM' ? 'Liked music' : 'Playlist'),
    subtitle,
    secondSubtitle,
    description,
    thumbnail,
    artists,
    songs: songsOf(playlist.items),
    hasMore: playlist.has_continuation,
    playlistId: id,
    sections: [],
  }
}

export async function loadMorePlaylist(id: string): Promise<{ songs: Song[]; hasMore: boolean }> {
  const page = playlistPages.get(id)
  if (!page?.has_continuation) return { songs: [], hasMore: false }
  const next = await page.getContinuation()
  playlistPages.set(id, next)
  return { songs: songsOf(next.items), hasMore: next.has_continuation }
}

/* ------------------------------------------------------------------ *
 * Artists and generic browse pages
 * ------------------------------------------------------------------ */

export async function getArtist(id: string): Promise<ArtistPage> {
  const yt = await innertube()
  const artist = await yt.music.getArtist(id)
  const header = artist.header

  const page: ArtistPage = { id, name: '', sections: sectionsOf(artist.sections) }

  if (header?.is(YTNodes.MusicImmersiveHeader)) {
    page.name = textOf(header.title)
    page.description = textOf(header.description) || undefined
    page.thumbnail = largest(header.thumbnail?.contents)
    const shuffle = payloadOf(header.play_button?.endpoint)
    const radio = payloadOf(header.start_radio_button?.endpoint)
    if (shuffle.playlistId) page.shuffle = { playlistId: shuffle.playlistId, params: shuffle.params }
    if (radio.playlistId) page.radio = { playlistId: radio.playlistId, params: radio.params }
  } else if (header?.is(YTNodes.MusicVisualHeader)) {
    page.name = textOf(header.title)
    page.thumbnail = largest(header.thumbnail) ?? largest(header.foreground_thumbnail)
  } else if (header?.is(YTNodes.MusicHeader)) {
    page.name = textOf(header.title)
  }

  return page
}

export async function browse(target: BrowseTarget): Promise<{ title: string; sections: Section[] }> {
  const yt = await innertube()
  const response = await yt.actions.execute('/browse', {
    browseId: target.browseId,
    params: target.params,
    client: 'YTMUSIC',
    parse: true,
  })

  const memo = response.contents_memo
  const shelves = memo?.getType(YTNodes.MusicCarouselShelf, YTNodes.MusicShelf, YTNodes.Grid, YTNodes.MusicPlaylistShelf) ?? []
  const header = memo?.getType(YTNodes.MusicHeader)?.[0]

  return { title: header ? textOf(header.title) : '', sections: sectionsOf(shelves) }
}

/* ------------------------------------------------------------------ *
 * Queues (watch next / radio)
 * ------------------------------------------------------------------ */

export interface QueuePage {
  songs: Song[]
  continuation?: string
  playlistId?: string
}

export async function getQueue(options: { videoId?: string; playlistId?: string; params?: string }): Promise<QueuePage> {
  const yt = await innertube()
  const response = await yt.actions.execute('/next', {
    videoId: options.videoId,
    playlistId: options.playlistId,
    params: options.params,
    isAudioOnly: true,
    enablePersistentPlaylistPanel: true,
    tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
    client: 'YTMUSIC',
    parse: true,
  })

  const panel = response.contents_memo?.getType(YTNodes.PlaylistPanel)?.[0]
  return {
    songs: songsOf(panel?.contents),
    continuation: panel?.continuation || undefined,
    playlistId: panel?.playlist_id || options.playlistId,
  }
}

export async function getQueueContinuation(continuation: string, playlistId?: string): Promise<QueuePage> {
  const yt = await innertube()
  const response = await yt.actions.execute('/next', {
    continuation,
    playlistId,
    isAudioOnly: true,
    enablePersistentPlaylistPanel: true,
    client: 'YTMUSIC',
    parse: true,
  })

  const contents = response.continuation_contents
  if (!contents?.is(PlaylistPanelContinuation)) return { songs: [], playlistId }
  return { songs: songsOf(contents.contents), continuation: contents.continuation || undefined, playlistId }
}

/** A radio seeded from a song: YouTube Music's "RDAMVM" playlists. */
export function radioFor(videoId: string) {
  return getQueue({ videoId, playlistId: `RDAMVM${videoId}` })
}

/* ------------------------------------------------------------------ *
 * Library (signed in)
 * ------------------------------------------------------------------ */

async function browseAllItems(browseId: string, maxPages = 6): Promise<Item[]> {
  const yt = await innertube()
  let response = await yt.actions.execute('/browse', { browseId, client: 'YTMUSIC', parse: true })

  const memo = response.contents_memo
  const items = itemsOf(memo?.getType(YTNodes.MusicTwoRowItem, YTNodes.MusicResponsiveListItem))
  const container = memo?.getType(YTNodes.Grid, YTNodes.MusicShelf)?.[0]
  let continuation = container?.continuation ?? null

  for (let page = 1; page < maxPages && continuation; page++) {
    response = await yt.actions.execute('/browse', { continuation, client: 'YTMUSIC', parse: true })
    const contents = response.continuation_contents
    if (contents?.is(GridContinuation)) {
      items.push(...itemsOf(contents.items))
      continuation = contents.continuation || null
    } else if (contents?.is(MusicShelfContinuation)) {
      items.push(...itemsOf(contents.contents))
      continuation = contents.continuation || null
    } else {
      continuation = null
    }
  }

  return items
}

export async function getLibraryPlaylists() {
  const items = await browseAllItems('FEmusic_liked_playlists')
  // The first tile is "New playlist"; liked music is shown separately.
  return items.filter((item) => item.type === 'playlist' && item.id !== 'LM' && !item.radio)
}

export async function getLibraryArtists() {
  const items = await browseAllItems('FEmusic_library_corpus_track_artists')
  return items.filter((item) => item.type === 'artist')
}

export async function setLiked(videoId: string, liked: boolean) {
  const yt = await innertube()
  await yt.actions.execute(liked ? '/like/like' : '/like/removelike', {
    target: { videoId },
    client: 'YTMUSIC',
  })
}
