import { Noctis, type Album, type Artist, type ArtistRef, type Item, type Song } from './host'

/**
 * Bandcamp, anonymously, through the surfaces that stay open: every album and
 * track has an embed page (bandcamp.com/EmbeddedPlayer/…) which isn't bot-walled
 * and carries the full track list with signed mp3-128 stream URLs — the same
 * streams the web player plays. Artist discographies come from <artist>.bandcamp
 * .com/music (also open). Bandcamp's own search/tag/discover pages sit behind a
 * Fastly "Client Challenge" on some networks, so search leans on the one open
 * JSON endpoint (tag lookup) and the embed/oEmbed surfaces, and says so clearly
 * when the wall is up.
 *
 * Item ids ("bandcamp:album:<id>", "bandcamp:track:<id>", "bandcamp:<subdomain>:…")
 * carry everything a later call needs: numeric ids go to the embed endpoints,
 * subdomain slugs to the artist site.
 */

export const SOURCE = 'bandcamp'
const EMBED = 'https://bandcamp.com/EmbeddedPlayer'
const { http } = Noctis.libs

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Raw = Record<string, any>

// A neutral UA: over HTTP/2, 'Mozilla/*' UAs get Fastly's Client Challenge on
// Bandcamp's shared domain (a browser-only check), while any other UA passes.
const UA = 'Noctis/1.0 (Bandcamp plugin)'
const headers = { 'user-agent': UA, accept: 'text/html,*/*' }
const jsonHeaders = { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' }

/** Ids: bandcamp:album:<id> / bandcamp:track:<id> (embed) and
 * bandcamp:artist:<subdomain> (discography). */
export const albumId = (id: number | string) => `${SOURCE}:album:${id}`
export const trackId = (id: number | string) => `${SOURCE}:track:${id}`
export const artistId = (subdomain: string) => `${SOURCE}:artist:${subdomain}`

export function rawId(id: string): string {
  return id.split(':').pop() ?? id
}

/** The id kind: 'album' | 'track' | 'artist' (and 'err' for anything else). */
export function kindOf(id: string): string {
  const [, kind] = id.split(':')
  return kind ?? 'err'
}

export class BandcampError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}

/** The Client Challenge page, recognizable by size and title: network-level, not fixable here. */
function isChallenged(html: string): boolean {
  return html.length < 5000 && /Client Challenge/i.test(html)
}

/** Log every request's outcome (status + size), and on failure keep the real cause
 * in the log while the screen gets a sentence without any of the words the app's
 * error view generalizes into "you're offline" (network, failed, timeout…). */
export async function requestPage(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<unknown> {
  const where = url.replace(/^https:\/\//, '').split('?')[0]
  try {
    const response = (await http.request(url, init)) as { status?: number; data?: unknown }
    const size = typeof response.data === 'string' ? response.data.length : JSON.stringify(response.data ?? '').length
    Noctis.writeLog(SOURCE, 'info', `[net] ${where} → ${response.status}, ${size} b`)
    return response
  } catch (error) {
    const cause = String((error as Error)?.message ?? error ?? 'unknown')
    Noctis.writeLog(SOURCE, 'warn', `[net] ${where} → error: ${cause.slice(0, 200)}`)
    throw new BandcampError("Bandcamp didn't answer — the Bandcamp plugin log says why")
  }
}

async function getHtml(url: string): Promise<string> {
  const response = (await requestPage(url, { headers })) as { status?: number; data?: unknown }
  if (typeof response.data !== 'string') throw new BandcampError('Bandcamp answered with something that is not a page')
  if (response.status !== 200) throw new BandcampError(`Bandcamp answered HTTP ${response.status}`, response.status)
  if (isChallenged(response.data)) {
    throw new BandcampError('Bandcamp bot-checked this page for apps (a "Client Challenge"); it may open in a browser')
  }
  return response.data
}

/** Undo HTML entities in the embed's JSON blob (it is attribute-encoded twice). */
function decodeEntities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/* ------------------------------------------------------------------ *
 * The embed: Bandcamp's one door that never asks questions
 * ------------------------------------------------------------------ */

export interface EmbedTrack {
  id: number
  title: string
  artist: string
  duration: number
  /** Signed stream URL (t4.bcbits.com), when the album streams. */
  file?: string
  trackNum?: number
  linkback?: string
}

export interface EmbedAlbum {
  albumId: number
  title: string
  artist: string
  subdomain: string
  artId?: number
  publishDate?: string
  tracks: EmbedTrack[]
  /** The album's own page, when the blob says where it lives. */
  linkback?: string
}

/** art at a size: f4.bcbits.com/img/<art_id>_<size>.jpg */
export function artAt(artId: number | string | null | undefined, size = 700): string | undefined {
  if (!artId) return undefined
  const bucket = size <= 200 ? 7 : size <= 400 ? 9 : size <= 700 ? 10 : 16
  return `https://f4.bcbits.com/img/a${artId}_${bucket}.jpg`
}

/** Fetch an embed page and pull the album JSON out of it. */
export async function embedAlbum(id: number | string, kind: 'album' | 'track' = 'album'): Promise<EmbedAlbum> {
  const html = await getHtml(`${EMBED}/${kind}=${rawId(String(id))}/size=large/artwork=small`)
  // The blob lives in the data-player-data attribute, entity-encoded JSON.
  const attr = /data-player-data="([^"]*)"/.exec(html)?.[1]
  if (!attr) {
    // Killed albums (removed/takedown) embed as a stub without data.
    if (/killed/.test(html)) throw new BandcampError('This release was removed from Bandcamp')
    throw new BandcampError('Bandcamp gave an empty embed for this release')
  }
  const json = JSON.parse(decodeEntities(attr)) as Raw
  if (!json?.tracks?.length) throw new BandcampError('Bandcamp has no streamable tracks for this release')
  const filesOf = (track: Raw): string | undefined => {
    const file = track.file
    if (!file) return undefined
    if (typeof file === 'string') {
      try {
        return JSON.parse(decodeEntities(file))['mp3-128']
      } catch {
        return undefined
      }
    }
    return (file as Raw)['mp3-128']
  }
  return {
    albumId: Number(json.album_id),
    title: String(json.album_title ?? json.title ?? ''),
    artist: String(json.artist ?? ''),
    subdomain: String(json.subdomain ?? ''),
    artId: json.album_art_id ?? json.art_id ?? undefined,
    publishDate: typeof json.publish_date === 'string' ? json.publish_date : undefined,
    linkback: typeof json.linkback === 'string' ? json.linkback : undefined,
    tracks: (json.tracks as Raw[]).map((track) => ({
      id: Number(track.id),
      title: String(track.title ?? ''),
      artist: String(track.artist ?? json.artist ?? ''),
      duration: Number(track.duration ?? 0),
      file: filesOf(track),
      trackNum: Number(track.tracknum ?? 0) || undefined,
      linkback: typeof track.title_link === 'string' ? track.title_link : undefined,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * Artist sites: the discography page lists everything with ids
 * ------------------------------------------------------------------ */

export interface ArtistDisco {
  subdomain: string
  name: string
  bio?: string
  artId?: number
  albums: { id: string; kind: 'album' | 'track'; title: string; artId?: number; artist?: string }[]
}

/** `<subdomain>.bandcamp.com/music`: grid items carry data-item-id="album-123". */
export async function artistDisco(subdomain: string): Promise<ArtistDisco> {
  const html = await getHtml(`https://${subdomain}.bandcamp.com/music`)
  const name = decodeEntities(/<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() ?? subdomain)
  const bio = decodeEntities(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '').slice(0, 400) || undefined
  const artId = /<link[^>]*rel="icon"[^>]*href="[^"]*img\/a(\d+)_/.exec(html)?.[1]
  const seen = new Set<string>()
  const albums: ArtistDisco['albums'] = []
  for (const match of html.matchAll(/data-item-id="(?:album|track)-(\d+)"[\s\S]{0,4000}?<a[^>]+href="(\/(?:album|track)\/[^"]+)"[\s\S]{0,2000}?<p[^>]*class="[^"]*title[^"]*"[^>]*>\s*(?:<span[^>]*>\s*)?([^<]{1,200}?)(?:<|\s*<\/)/g)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    const kind = /data-item-id="album-/.test(match[0]) ? 'album' : 'track'
    albums.push({
      id,
      kind,
      title: decodeEntities(match[3]).trim(),
      artId: /img src="[^"]*img\/a(\d+)_/.exec(match[0])?.[1] ? Number(/img src="[^"]*img\/a(\d+)_/.exec(match[0])![1]) : undefined,
    })
  }
  // Fallback: plain album links with ids elsewhere in the row.
  if (albums.length === 0) {
    for (const match of html.matchAll(/href="(\/(?:album|track)\/[a-z0-9-]+)"/g)) {
      const href = match[1]
      const numeric = new RegExp(`"${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,600}?data-item-id="(?:album|track)-(\\d+)"`).exec(html)
        ?? new RegExp(`data-item-id="(?:album|track)-(\\d+)"[\\s\\S]{0,600}?"${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(html)
      if (numeric && !seen.has(numeric[1])) {
        seen.add(numeric[1])
        albums.push({ id: numeric[1], kind: href.startsWith('/album') ? 'album' : 'track', title: href.split('/').pop()!.replace(/-/g, ' ') })
      }
    }
  }
  if (albums.length === 0) throw new BandcampError(`No releases found on ${subdomain}.bandcamp.com/music`)
  return { subdomain, name, bio, artId: artId ? Number(artId) : undefined, albums }
}

/* ------------------------------------------------------------------ *
 * Bandcamp's open JSON endpoints
 * ------------------------------------------------------------------ */

/** Tag lookup: real tags with counts ("ambient" → 793k releases). */
export async function tagSearch(term: string): Promise<{ name: string; norm: string; count: number }[]> {
  const response = (await requestPage('https://bandcamp.com/api/fansignup/1/search_tag', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ search_term: term }),
  })) as { status?: number; data?: Raw }
  const json = (response?.data ?? {}) as Raw
  return ((json?.matching_tags ?? []) as Raw[]).map((tag) => ({ name: String(tag.tag_name), norm: String(tag.tag_norm_name), count: Number(tag.count ?? 0) }))
}

/** A fresh token for an expiring stream URL (the web player's renewal call). */
export async function refreshStream(url: string): Promise<string | null> {
  const response = (await http.request('https://bandcamp.com/api/stream/1/refresh', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ url }),
  }).catch(() => null)) as { data?: Raw } | null
  const json = (response?.data ?? undefined) as Raw | undefined
  return typeof json?.url === 'string' ? json.url : null
}

/* ------------------------------------------------------------------ *
 * Mappers: Bandcamp → Noctis models
 * ------------------------------------------------------------------ */

function artistsOf(embed: EmbedAlbum, track?: EmbedTrack): ArtistRef[] {
  const name = track?.artist || embed.artist || 'Unknown artist'
  const refs: ArtistRef[] = [{ name }]
  if (embed.subdomain && name === embed.artist) refs[0].id = artistId(embed.subdomain)
  return refs
}

export function toSong(embed: EmbedAlbum, track: EmbedTrack): Song {
  return {
    type: 'song',
    source: SOURCE,
    id: trackId(track.id),
    title: track.title || 'Untitled',
    artists: artistsOf(embed, track),
    album: embed.title ? { id: albumId(embed.albumId), name: embed.title } : undefined,
    duration: Math.round(track.duration) || undefined,
    thumbnail: artAt(embed.artId, 400),
  }
}

/** An album-shaped page from an embed. */
export function toAlbumPage(embed: EmbedAlbum): Album {
  const year = embed.publishDate?.match(/\d{4}/)?.[0]
  return {
    type: 'album',
    source: SOURCE,
    id: albumId(embed.albumId),
    title: embed.title || embed.artist,
    artists: artistsOf(embed),
    year,
    thumbnail: artAt(embed.artId),
    kind: 'Album',
  }
}

export function toAlbumItem(id: number | string, title: string, artist: string, artId?: number, subdomain?: string): Item {
  return {
    type: 'album',
    source: SOURCE,
    id: albumId(id),
    title,
    artists: [{ ...(subdomain ? { id: artistId(subdomain) } : {}), name: artist || 'Unknown artist' }],
    thumbnail: artAt(artId),
  } as Item
}

/** Item → its bandcamp page, for "Copy link" (the embed's linkback, when known). */
const permalinks = new Map<string, string>()
export function rememberPermalink(id: string, url: string | undefined) {
  if (url) {
    permalinks.set(id, url)
    if (permalinks.size > 3000) permalinks.delete(permalinks.keys().next().value!)
  }
}
export const permalinkOf = (id: string) => permalinks.get(id)

/** An artist item from a discography. */
export function toArtistItem(disco: ArtistDisco): Artist {
  return {
    type: 'artist',
    source: SOURCE,
    id: artistId(disco.subdomain),
    name: disco.name,
    subtitle: `${disco.albums.length} release${disco.albums.length === 1 ? '' : 's'}`,
    thumbnail: artAt(disco.artId),
  }
}
