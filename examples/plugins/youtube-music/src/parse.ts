import { YTNodes, type Helpers } from 'youtubei.js'
import type { Album, Artist, ArtistRef, Item, Playlist, Section, Song } from '../../models'
import { largest } from './thumbnails'

type YTNode = Helpers.YTNode

interface RawEndpointPayload {
  browseId?: string
  params?: string
  videoId?: string
  playlistId?: string
  watchEndpointMusicSupportedConfigs?: {
    watchEndpointMusicConfig?: { musicVideoType?: string }
  }
}

interface EndpointLike {
  payload?: unknown
}

export function payloadOf(endpoint: EndpointLike | null | undefined): RawEndpointPayload {
  return (endpoint?.payload ?? {}) as RawEndpointPayload
}

export function stripBrowsePrefix(id: string | undefined): string {
  if (!id) return ''
  return id.startsWith('VL') ? id.slice(2) : id
}

interface RefLike {
  name: string
  channel_id?: string
}

function refs(list: RefLike[] | undefined): ArtistRef[] {
  return (list ?? [])
    .filter((artist) => artist.name)
    .map((artist) => ({ name: artist.name, id: artist.channel_id }))
}

/** Badges arrive in several container shapes; look for the explicit one anywhere. */
function isExplicit(badges: unknown): boolean {
  const list: unknown[] = Array.isArray(badges)
    ? badges
    : badges && typeof badges === 'object' && Symbol.iterator in badges
      ? [...(badges as Iterable<unknown>)]
      : []
  return list.some(
    (badge) =>
      typeof badge === 'object' &&
      badge !== null &&
      (badge as { icon_type?: string }).icon_type === 'MUSIC_EXPLICIT_BADGE',
  )
}

function textOf(value: { toString(): string } | undefined | null): string {
  const text = value?.toString() ?? ''
  return text === 'N/A' ? '' : text
}

/** "Song • Artist • Album" style subtitles, used when runs carry no artist links. */
function artistsFromSubtitle(subtitle: string): ArtistRef[] {
  const parts = subtitle.split(' • ').map((part) => part.trim())
  const labels = /^(song|video|single|ep|album|playlist|episode)$/i
  const name = parts.find((part) => part && !labels.test(part) && !/^\d+(:\d+)+$/.test(part))
  return name ? [{ name }] : []
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

export function fromListItem(item: YTNodes.MusicResponsiveListItem): Item | null {
  const thumbnail = largest(item.thumbnail?.contents)
  const secondLine = textOf(item.flex_columns.at(1)?.title)

  switch (item.item_type) {
    case 'song':
    case 'video':
    case 'non_music_track': {
      if (!item.id) return null
      const artists = refs(item.artists ?? item.authors)
      return {
        type: 'song',
        id: item.id,
        title: item.title ?? textOf(item.flex_columns.at(0)?.title),
        artists: artists.length > 0 ? artists : artistsFromSubtitle(secondLine),
        album: item.album?.id ? { id: item.album.id, name: item.album.name } : undefined,
        duration: item.duration?.seconds || undefined,
        thumbnail,
        explicit: isExplicit(item.badges),
        isVideo: item.item_type === 'video',
      }
    }

    case 'album':
      if (!item.id) return null
      return {
        type: 'album',
        id: item.id,
        title: item.title ?? '',
        artists: item.author ? refs([item.author]) : artistsFromSubtitle(secondLine),
        year: item.year,
        thumbnail,
        explicit: isExplicit(item.badges),
        kind: secondLine.split(' • ')[0] || undefined,
      }

    case 'playlist':
      if (!item.id) return null
      return {
        type: 'playlist',
        id: stripBrowsePrefix(item.id),
        title: item.title ?? '',
        subtitle: secondLine || undefined,
        thumbnail,
      }

    case 'artist':
      if (!item.id) return null
      return { type: 'artist', id: item.id, name: item.name ?? '', subtitle: secondLine || undefined, thumbnail }

    case 'library_artist': {
      // Library artist pages are "MPLA" + channel id; the public artist page is nicer.
      const browseId = payloadOf(item.endpoint).browseId ?? ''
      const id = browseId.startsWith('MPLA') ? browseId.slice(4) : browseId
      if (!id) return null
      return { type: 'artist', id, name: item.name ?? '', subtitle: secondLine || undefined, thumbnail }
    }

    default: {
      const payload = payloadOf(item.endpoint)
      if (payload.videoId) {
        return {
          type: 'song',
          id: payload.videoId,
          title: item.title ?? textOf(item.flex_columns.at(0)?.title),
          artists: artistsFromSubtitle(secondLine),
          thumbnail,
        }
      }
      return null
    }
  }
}

export function fromTwoRowItem(item: YTNodes.MusicTwoRowItem): Item | null {
  const thumbnail = largest(item.thumbnail)
  const title = textOf(item.title)
  const subtitle = textOf(item.subtitle)
  const payload = payloadOf(item.endpoint)

  switch (item.item_type) {
    case 'album': {
      if (!item.id) return null
      const album: Album = {
        type: 'album',
        id: item.id,
        title,
        artists: refs(item.artists),
        year: item.year,
        thumbnail,
        explicit: isExplicit(item.badges),
        kind: subtitle.split(' • ')[0] || undefined,
      }
      if (album.artists.length === 0) album.artists = artistsFromSubtitle(subtitle)
      return album
    }

    case 'playlist':
      if (!item.id) return null
      return { type: 'playlist', id: stripBrowsePrefix(item.id), title, subtitle: subtitle || undefined, thumbnail }

    case 'artist':
      if (!item.id) return null
      return { type: 'artist', id: item.id, name: title, subtitle: item.subscribers || subtitle || undefined, thumbnail }

    default: {
      if (payload.videoId && !payload.playlistId?.startsWith('RD')) {
        const musicVideoType = payload.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType
        const artists = refs(item.artists ?? (item.author ? [item.author] : undefined))
        return {
          type: 'song',
          id: payload.videoId,
          title,
          artists: artists.length > 0 ? artists : artistsFromSubtitle(subtitle),
          thumbnail,
          explicit: isExplicit(item.badges),
          isVideo: musicVideoType ? musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV' : item.item_type === 'video',
        }
      }
      if (payload.playlistId) {
        return {
          type: 'playlist',
          id: payload.playlistId,
          title,
          subtitle: subtitle || undefined,
          thumbnail,
          radio: { videoId: payload.videoId, params: payload.params },
        }
      }
      return null
    }
  }
}

export function fromPanelVideo(video: YTNodes.PlaylistPanelVideo): Song | null {
  if (!video.video_id) return null
  const artists = refs(video.artists)
  return {
    type: 'song',
    id: video.video_id,
    title: textOf(video.title),
    artists: artists.length > 0 ? artists : video.author ? [{ name: video.author }] : [],
    album: video.album?.id ? { id: video.album.id, name: video.album.name } : undefined,
    duration: video.duration?.seconds || undefined,
    thumbnail: largest(video.thumbnail),
    explicit: isExplicit(video.badges),
  }
}

/** Map any node that represents a song, album, playlist or artist. */
export function fromNode(node: YTNode): Item | null {
  if (node.is(YTNodes.MusicResponsiveListItem)) return fromListItem(node)
  if (node.is(YTNodes.MusicTwoRowItem)) return fromTwoRowItem(node)
  if (node.is(YTNodes.PlaylistPanelVideo)) return fromPanelVideo(node)
  if (node.is(YTNodes.PlaylistPanelVideoWrapper) && node.primary) return fromPanelVideo(node.primary)
  return null
}

export function itemsOf(nodes: Iterable<YTNode> | null | undefined): Item[] {
  const items: Item[] = []
  const seen = new Set<string>()
  for (const node of nodes ?? []) {
    const item = fromNode(node)
    if (!item) continue
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

export function songsOf(nodes: Iterable<YTNode> | null | undefined): Song[] {
  return itemsOf(nodes).filter((item): item is Song => item.type === 'song')
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

let sectionCounter = 0
/** Section ids must stay unique next to sections restored from the on-device cache. */
const sectionPrefix = Math.random().toString(36).slice(2, 8)
const nextSectionId = () => `section-${sectionPrefix}-${sectionCounter++}`

export function fromCarousel(shelf: YTNodes.MusicCarouselShelf): Section | null {
  const items = itemsOf(shelf.contents)
  if (items.length === 0) return null

  const header = shelf.header
  const moreEndpoint = payloadOf(header?.more_content?.endpoint)
  const listItems = shelf.contents.filter((node) => node.is(YTNodes.MusicResponsiveListItem)).length
  const headerThumb = largest(header?.thumbnail?.contents)

  return {
    id: nextSectionId(),
    title: textOf(header?.title),
    strapline: textOf(header?.strapline) || undefined,
    thumbnail: headerThumb,
    thumbnailRound: Boolean(headerThumb && /ggpht|=s\d+|-c-k/.test(headerThumb)),
    layout: listItems > items.length / 2 ? 'quick-picks' : 'carousel',
    items,
    more: moreEndpoint.browseId ? { browseId: moreEndpoint.browseId, params: moreEndpoint.params } : undefined,
  }
}

export function fromShelf(shelf: YTNodes.MusicShelf): Section | null {
  const items = itemsOf(shelf.contents)
  if (items.length === 0) return null

  const more = payloadOf(shelf.endpoint ?? shelf.bottom_button?.endpoint)
  return {
    id: nextSectionId(),
    title: textOf(shelf.title),
    layout: 'list',
    items,
    more: more.browseId ? { browseId: more.browseId, params: more.params } : undefined,
  }
}

export function fromGrid(grid: YTNodes.Grid, title = ''): Section | null {
  const items = itemsOf(grid.items)
  if (items.length === 0) return null
  const header = grid.header?.is(YTNodes.GridHeader) ? textOf(grid.header.title) : ''
  return { id: nextSectionId(), title: title || header, layout: 'carousel', items }
}

/** Turn whatever shelves a page contains into sections, in order. */
export function sectionsOf(nodes: Iterable<YTNode> | null | undefined): Section[] {
  const sections: Section[] = []
  for (const node of nodes ?? []) {
    let section: Section | null = null
    if (node.is(YTNodes.MusicCarouselShelf)) section = fromCarousel(node)
    else if (node.is(YTNodes.MusicShelf)) section = fromShelf(node)
    else if (node.is(YTNodes.Grid)) section = fromGrid(node)
    else if (node.is(YTNodes.MusicPlaylistShelf)) {
      const items = itemsOf(node.contents)
      if (items.length > 0) section = { id: nextSectionId(), title: '', layout: 'list', items }
    }
    if (section) sections.push(section)
  }
  return sections
}

export function isArtist(item: Item): item is Artist {
  return item.type === 'artist'
}

export function isPlaylist(item: Item): item is Playlist {
  return item.type === 'playlist'
}
