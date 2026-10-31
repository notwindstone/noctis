import type { ArtistPage, CollectionPage, HomeResult, Item, PluginScope, QueuePage, RadioSeed, SearchResult, Section, ServiceDefinition, Song, StreamInfo } from './host'
import { Noctis } from './host'
import {
  albumId,
  artistDisco,
  artistId,
  artAt,
  BandcampError,
  embedAlbum,
  kindOf,
  permalinkOf,
  rawId,
  rememberPermalink,
  requestPage,
  SOURCE,
  tagSearch,
  toAlbumItem,
  toSong,
  trackId,
  type EmbedAlbum,
} from './api'

/**
 * Bandcamp for Noctis: browse artists' discographies, open albums, play full
 * tracks anonymously (the way the web player's embed does), discover by tag.
 * No account: everything on Bandcamp is buy-to-own, and bought music needs no
 * sign-in to stream — so the plugin has none.
 */

const { StreamError } = Noctis.libs.stream

// A neutral UA: over HTTP/2, 'Mozilla/*' user agents get Fastly's Client Challenge
// on Bandcamp's shared domain, any other UA passes (a quirk of their bot filter).
const UA_H = { 'user-agent': 'Noctis/1.0 (Bandcamp plugin)', accept: 'text/html,*/*' }

/** Home sections from tags people actually browse. */
const GENRES = [
  { tag: 'electronic', title: 'Electronic' },
  { tag: 'hip-hop-rap', title: 'Hip-Hop' },
  { tag: 'rock', title: 'Rock' },
  { tag: 'ambient', title: 'Ambient' },
  { tag: 'jazz', title: 'Jazz' },
  { tag: 'experimental', title: 'Experimental' },
  { tag: 'metal', title: 'Metal' },
  { tag: 'folk', title: 'Folk' },
  { tag: 'punk', title: 'Punk' },
  { tag: 'soul-r-b', title: 'Soul & R&B' },
]

const section = (id: string, title: string, items: (Item | null)[], layout: Section['layout'] = 'carousel', strapline?: string): Section[] => {
  const list = items.filter((item): item is Item => item !== null)
  return list.length > 0 ? [{ id, title, items: list, layout, strapline }] : []
}

/* ------------------------------------------------------------------ *
 * Album + track pages (the embed is the data source for both)
 * ------------------------------------------------------------------ */

const embedCache = new Map<string, EmbedAlbum>()
const remember = (key: string, embed: EmbedAlbum) => {
  embedCache.delete(key)
  embedCache.set(key, embed)
  for (const old of embedCache.keys()) {
    if (embedCache.size <= 24) break
    embedCache.delete(old)
  }
}

/** An EmbedAlbum for "bandcamp:album:N" or "bandcamp:track:N" ids. */
async function embedOf(id: string): Promise<EmbedAlbum> {
  const kind = kindOf(id) === 'track' ? 'track' : 'album'
  const key = `${kind}:${rawId(id)}`
  const cached = embedCache.get(key)
  if (cached) return cached
  const embed = await embedAlbum(rawId(id), kind as 'album' | 'track')
  remember(key, embed)
  return embed
}

async function getCollection({ id }: { id: string }): Promise<CollectionPage> {
  const embed = await embedOf(id)
  rememberPermalink(id, embed.linkback)
  const songs = embed.tracks.map((track) => toSong(embed, track))
  return {
    id,
    kind: 'album',
    title: embed.title || embed.artist,
    subtitle: [embed.artist, embed.publishDate?.match(/\d{4}/)?.[0]].filter(Boolean).join(' • '),
    thumbnail: artAt(embed.artId),
    artists: [{ ...(embed.subdomain ? { id: artistId(embed.subdomain) } : {}), name: embed.artist || 'Unknown artist' }],
    year: embed.publishDate?.match(/\d{4}/)?.[0],
    songs,
    hasMore: false,
    sections: [],
  }
}

/* ------------------------------------------------------------------ *
 * Artists: the discography page
 * ------------------------------------------------------------------ */

async function getArtist({ id }: { id: string }): Promise<ArtistPage> {
  const subdomain = rawId(id)
  const disco = await artistDisco(subdomain)
  const items: (Item | null)[] = disco.albums.map((entry) => ({
    type: 'album',
    source: SOURCE,
    id: entry.kind === 'album' ? albumId(entry.id) : trackId(entry.id),
    title: entry.title,
    artists: [{ id: artistId(subdomain), name: disco.name }],
    thumbnail: artAt(entry.artId),
  }) as Item)
  return {
    id,
    name: disco.name,
    description: disco.bio,
    thumbnail: artAt(disco.artId),
    sections: section('all', 'Discography', items, 'list'),
  }
}

/* ------------------------------------------------------------------ *
 * Search: Bandcamp's own page is bot-walled on some networks; the open doors
 * are tag lookup (JSON) and anything the user reaches by link. Track/album
 * search goes through bandcamp.com/search and explains the wall when it fires.
 * ------------------------------------------------------------------ */

const SEARCH_TYPES: Record<string, { label: string; param: string }> = {
  all: { label: 'All', param: '' },
  album: { label: 'Albums', param: 'a' },
  artist: { label: 'Artists', param: 'b' },
  song: { label: 'Tracks', param: 't' },
}

/** bandcamp.com/search rows (old layout): <li class="search-item"> with
 * data-item-id / data-art / names and a resulttype. */
function parseSearchPage(html: string): { items: Item[]; tags: { name: string; norm: string; count: number }[] } {
  const items: Item[] = []
  if (/class="search-item"/.test(html)) {
    for (const match of html.matchAll(/<li[^>]+class="search-item[^"]*"([\s\S]*?)<\/li>/g)) {
      const row = match[1]
      const type = /data-search="(album|track|artist|fan)"/.exec(row)?.[1] ?? 'album'
      const numeric = /data-item-id="(?:album|track)-(\d+)"/.exec(row)?.[1] ?? /\/(album|track)\/[^"]*"/.exec(row)?.[0]
      const subdomain = /search-result-band-url"[^>]*>\s*https?:\/\/([a-z0-9-]+)\.bandcamp\.com/i.exec(row)?.[1]
        ?? /https?:\/\/([a-z0-9-]+)\.bandcamp\.com/.exec(row)?.[1]
      const heading = /class="[^"]*item-type[^"]*"[^>]*>([^<]+)</.exec(row)?.[1]?.trim()
      const title = decodeRow(row)
      if (type === 'artist' && subdomain) {
        items.push({ type: 'artist', source: SOURCE, id: artistId(subdomain), name: title, thumbnail: artAt(/img\/a(\d+)_/.exec(row)?.[1]) } as Item)
      } else if (numeric && /^\d+$/.test(numeric) && subdomain) {
        const kind = type === 'track' || heading?.toLowerCase().includes('track') ? 'track' : 'album'
        items.push(toAlbumItem(numeric, title, subdomain, /img\/a(\d+)_/.exec(row)?.[1] ? Number(/img\/a(\d+)_/.exec(row)![1]) : undefined, subdomain))
        void kind
      } else if (subdomain) {
        items.push({ type: 'artist', source: SOURCE, id: artistId(subdomain), name: title } as Item)
      }
    }
  }
  return { items, tags: [] }
}

function decodeRow(row: string): string {
  return (
    row
      .match(/class="[^"]*heading[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<]{1,300}?)\s*(?:<\/a>)?\s*</)?.[1]
      ?.replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .trim() ?? 'Untitled'
  )
}

async function searchQuery({ query, type }: { query: string; type: string }): Promise<SearchResult> {
  const wanted = SEARCH_TYPES[type]?.param ?? ''
  // Tag searches ride the open JSON endpoint; everything else needs the search page.
  if (/^#/.test(query.trim())) {
    const tags = await tagSearch(query.trim().slice(1))
    return {
      sections: section('tags', 'Tags', tags.map((tag) => ({
        type: 'playlist',
        source: SOURCE,
        id: `${SOURCE}:tag:${tag.norm}`,
        title: `#${tag.name}`,
        subtitle: `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tag.count)} releases`,
      } as Item)), 'list'),
      items: [],
      hasMore: false,
    }
  }
  const response = (await requestPage(`https://bandcamp.com/search?q=${encodeURIComponent(query)}${wanted ? `&item_type=${wanted}` : ''}`, {
    headers: UA_H,
  }).catch(() => null)) as { status?: number; data?: unknown } | null
  const html = String(response?.data ?? '')
  if (!html) throw new BandcampError('Bandcamp search did not answer')
  if (response && response.status !== 200) throw new BandcampError(`Bandcamp search answered HTTP ${response.status}`)
  const parsed = parseSearchPage(html)
  if (parsed.items.length === 0 && /Client Challenge/i.test(html)) {
    throw new BandcampError('Bandcamp bot-checks its search page for apps. Tag search works though: start your query with # (like "#ambient") — or search on bandcamp.com and open the album link here.')
  }
  return { sections: [], items: parsed.items, hasMore: false }
}

/* ------------------------------------------------------------------ *
 * Tag pages as pseudo-collections ("#ambient" ids). Bandcamp bot-checks its
 * tag/discover pages for non-browser clients (they redirect to /discover/…,
 * which serves a "Client Challenge" shell), so this only works where Bandcamp
 * lets the client through; the error says so plainly. When the real page does
 * load, its grid rows carry album ids + art.
 * ------------------------------------------------------------------ */

async function getTagListing({ id }: { id: string }): Promise<CollectionPage> {
  const tag = rawId(id)
  const response = (await requestPage(`https://bandcamp.com/tag/${encodeURIComponent(tag)}`, {
    headers: UA_H,
  }).catch(() => null)) as { status?: number; data?: unknown } | null
  const html = String(response?.data ?? '')
  const albums: Item[] = []
  for (const match of html.matchAll(/data-item-id="album-(\d+)"[\s\S]{0,3000}?<a[^>]+href="https:\/\/([a-z0-9-]+)\.bandcamp\.com(\/album\/[^"]+)"[\s\S]{0,1500}?<p[^>]*class="[^"]*title[^"]*"[^>]*>\s*([^<]{1,200}?)\s*</g)) {
    const artId = /img src="[^"]*img\/a(\d+)_/.exec(match[0])?.[1]
    albums.push(toAlbumItem(match[1], match[4].trim(), match[2], artId ? Number(artId) : undefined, match[2]))
    if (albums.length >= 40) break
  }
  if (albums.length === 0) {
    throw new BandcropTagError(tag)
  }
  return {
    id,
    kind: 'playlist',
    title: `#${tag}`,
    subtitle: `${albums.length} releases`,
    artists: [],
    songs: [],
    hasMore: false,
    sections: section('albums', 'Albums', albums, 'list'),
  }
}

class BandcropTagError extends BandcampError {
  constructor(tag: string) {
    super(`Bandcamp bot-checks its #${tag} page for apps, so it may only open in a browser. Search and artist pages still work here`)
  }
}

/* ------------------------------------------------------------------ *
 * Home. Two shelves: featured releases (a curated set of bandcamp-native
 * albums, each verified streamable through the embed — the one surface with no
 * bot wall — and rendered live so dead ones drop out), and tag shortcuts.
 * ------------------------------------------------------------------ */

/** Verified streamable albums (embed-checked; artist, title and art come live
 * from Bandcamp at load time). */
const FEATURED = [
  'bandcamp:album:1349219244', // C418 — Minecraft - Volume Alpha
  'bandcamp:album:251082545', // TENGGER — Earthing
  'bandcamp:album:2492763022', // TENGGER
  'bandcamp:album:270284268', // Cloudkicker — Solitude
  'bandcamp:album:3270222563', // Cloudkicker — Things You Can't Change
  'bandcamp:album:2520712207', // Cloudkicker — 2026_folder1
  'bandcamp:album:1594691916', // Boards of Canada — Free Remixes (Vol 2)
  'bandcamp:album:3075750591', // Massive Attack — Free Remixes (Vol 1)
]

async function loadHome(): Promise<HomeResult> {
  const settled = async <T>(promise: Promise<T>): Promise<T | null> => {
    try {
      return await promise
    } catch {
      return null
    }
  }
  const featured = (await Promise.all(FEATURED.map(async (id) => {
    const embed = await settled(embedOf(id))
    if (!embed?.linkback && !embed) return null
    rememberPermalink(id, embed.linkback)
    return toAlbumItem(embed.albumId, embed.title || embed.artist, embed.artist, embed.artId, embed.subdomain || undefined)
  }))).filter((item): item is Item => item !== null)
  return {
    sections: [
      ...section('featured', 'Featured releases', featured),
      ...section('genres', 'Browse tags', GENRES.map((genre) => ({
        type: 'playlist',
        source: SOURCE,
        id: `${SOURCE}:tag:${genre.tag}`,
        title: genre.title,
        subtitle: `#${genre.tag}`,
      } as Item)), 'carousel'),
    ],
    filters: [],
    selectedFilter: null,
    hasMore: false,
  }
}

/* ------------------------------------------------------------------ *
 * Queue: albums and artist radios (shuffle the discography)
 * ------------------------------------------------------------------ */

function shuffle<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function artistSongs(subdomain: string): Promise<Song[]> {
  const disco = await artistDisco(subdomain)
  const songs: Song[] = []
  for (const entry of disco.albums.slice(0, 12)) {
    try {
      const embed = await embedAlbum(entry.id, entry.kind)
      songs.push(...embed.tracks.filter((track) => track.file).map((track) => toSong(embed, track)))
    } catch {
      // removed / purchase-only releases: skip
    }
    if (songs.length >= 60) break
  }
  return songs
}

const queue = {
  async start({ playlistId }: { playlistId?: string }): Promise<QueuePage> {
    const value = String(playlistId ?? '')
    if (value.startsWith('artist-shuffle:')) {
      const songs = await artistSongs(value.slice('artist-shuffle:'.length))
      return { songs: shuffle(songs) }
    }
    return { songs: [] }
  },
  async radio(seed: RadioSeed): Promise<QueuePage> {
    // A radio from any seed: play the seed, then more from its artist.
    const [first] = seed.kind === 'song' ? [seed.song] : []
    if (first) {
      const subdomain = first.artists?.find((artist) => artist.id?.startsWith(`${SOURCE}:artist:`))?.id?.split(':').pop()
      const more = subdomain ? (await artistSongs(subdomain)).filter((song) => song.id !== first.id) : []
      return { songs: [first, ...shuffle(more)] }
    }
    const album = seed.kind === 'album' ? seed.album : seed.kind === 'playlist' ? seed.playlist : null
    if (album) {
      const page = await getCollection({ id: album.id })
      return { songs: page.songs }
    }
    return { songs: [] }
  },
}

/* ------------------------------------------------------------------ *
 * Streams: the embed's signed mp3-128 URLs, renewed when they lapse
 * ------------------------------------------------------------------ */

async function resolveStream({ song, efficient }: { song: Song; efficient: boolean }): Promise<StreamInfo> {
  // mp3-128 is the only anonymous encoding; "efficient" is already satisfied.
  void efficient
  const id = rawId(song.id)
  const albumRef = song.album?.id
  let embed: EmbedAlbum | undefined
  try {
    embed = await embedOf(String(albumRef ?? song.id))
  } catch {
    embed = undefined
  }
  const track = embed?.tracks.find((entry) => String(entry.id) === id)
  const file = track?.file
  if (!file) {
    throw new StreamError(embed ? "Bandcamp doesn't stream this release anonymously (purchase-only audio)" : "Couldn't find this track's audio on Bandcamp")
  }
  const expiresAt = Date.now() + 60 * 60_000
  return { url: file, mimeType: 'audio/mpeg', bitrate: 128_000, contentLength: undefined, expiresAt }
}

/* ------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------ */

const service: ServiceDefinition = {
  name: 'Bandcamp',
  icon: 'camping',
  home: { load: loadHome },
  search: {
    filters: [
      { id: 'all', label: 'All' },
      { id: 'album', label: 'Albums' },
      { id: 'artist', label: 'Artists' },
      { id: 'song', label: 'Tracks' },
    ],
    query: searchQuery,
  },
  albums: { get: getCollection },
  playlists: { get: getTagListing },
  artists: { get: getArtist },
  queue,
  streams: { resolve: resolveStream },
  links: {
    share: (item) => permalinkOf(item.id) ?? (item.type === 'artist' ? `https://${rawId(item.id)}.bandcamp.com` : undefined),
  },
  thumbnails: {
    resize: (url, size) => (/f4\.bcbits\.com\/img\/a\d+_/.test(url) ? artAt(/a(\d+)_/.exec(url)?.[1], size) : undefined),
  },
}

export default function bandcamp({ Plugin }: PluginScope) {
  const attach = () => {
    Plugin.defineService(SOURCE, service)
  }
  const detach = () => {
    Plugin.removeService(SOURCE)
  }
  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
