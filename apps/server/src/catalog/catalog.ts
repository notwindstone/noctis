import type { Database } from '../db'

/**
 * The music catalog (PostgreSQL): artists, albums and songs, each song with one or more
 * sources, plus per-user stars, ratings, plays, playlists, play queues and bookmarks.
 *
 * Songs come from providers, which are plugins (`Noctis.catalog.upsertSong`): the
 * local-library plugin for files on the server, service plugins for the rest. The same
 * song from two providers becomes one song with two sources (ids are derived from
 * artist, album and title), so a client or the server can pick the best or most
 * convenient one to play.
 *
 * BIGINT columns are read as float8 so they arrive as numbers.
 */

export interface SourceInput {
  /** Provider id (a plugin's, e.g. "local"). */
  provider: string
  /** The song's id at that provider (a file path, a video id…). */
  externalId: string
  contentType?: string
  suffix?: string
  /** kbps */
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  size?: number
  lossless?: boolean
}

export interface SongInput {
  title: string
  artist: string
  album?: string
  /** Defaults to `artist`. */
  albumArtist?: string
  track?: number
  disc?: number
  year?: number
  genre?: string
  /** Seconds. */
  duration?: number
  /** Artwork: an https URL, or "<provider>:<anything>" for the provider's cover(). */
  cover?: string
  tags?: string[]
  source: SourceInput
}

export interface SongRow {
  id: string
  title: string
  album_id: string
  album_name: string
  artist_id: string
  artist_name: string
  track: number | null
  disc: number | null
  year: number | null
  genre: string | null
  duration: number | null
  cover: string | null
  tags: string[]
  created: number
  content_type: string | null
  suffix: string | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  size: number | null
  starred: number | null
  play_count: number
  rating: number | null
}

export interface AlbumRow {
  id: string
  name: string
  artist_id: string
  artist_name: string
  year: number | null
  genre: string | null
  cover: string | null
  created: number
  song_count: number
  duration: number
  starred: number | null
  play_count: number
  rating: number | null
}

export interface ArtistRow {
  id: string
  name: string
  sort_name: string
  cover: string | null
  album_count: number
  starred: number | null
  rating: number | null
}

export interface SourceRow {
  song_id: string
  provider: string
  external_id: string
  content_type: string | null
  suffix: string | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  size: number | null
  lossless: boolean
}

export interface PlaylistRow {
  id: string
  name: string
  owner_id: number
  owner: string
  comment: string | null
  public: boolean
  created: number
  changed: number
  song_count: number
  duration: number
}

export interface PlayQueueRow {
  song_ids: string[]
  current_index: number | null
  position_ms: number
  changed: number
  changed_by: string
}

export interface BookmarkRow {
  song_id: string
  position_ms: number
  comment: string | null
  created: number
  changed: number
}

export type AlbumListType =
  | 'random'
  | 'newest'
  | 'frequent'
  | 'recent'
  | 'starred'
  | 'highest'
  | 'alphabeticalByName'
  | 'alphabeticalByArtist'
  | 'byYear'
  | 'byGenre'

const ARTICLES = /^(the|a|an|les|la|le|die|der|das)\s+/i

function hashId(prefix: string, ...parts: string[]): string {
  const hasher = new Bun.CryptoHasher('sha1')
  hasher.update(parts.map((part) => part.trim().toLowerCase()).join('\u0000'))
  return `${prefix}${hasher.digest('hex').slice(0, 20)}`
}

export const artistIdFor = (name: string) => hashId('ar-', name)
export const albumIdFor = (artistId: string, name: string) => hashId('al-', artistId, name)
export const songIdFor = (albumId: string, title: string, disc = 1) => hashId('so-', albumId, title, String(disc))

/** LIKE pattern for a search query (escaped). */
const like = (query: string) => `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

export class Catalog {
  constructor(private readonly sql: Database) {}

  /* ---------------- Query fragments, annotated for one user ---------------- */

  private songSelect(user: number) {
    return this.sql`
      SELECT s.id, s.title, s.album_id, al.name AS album_name, s.artist_id, ar.name AS artist_name,
        s.track, s.disc, s.year, s.genre, s.duration, s.cover, s.tags, s.created::float8 AS created,
        src.content_type, src.suffix, src.bitrate, src.sample_rate, src.bit_depth, src.channels, src.size::float8 AS size,
        (SELECT at::float8 FROM stars WHERE user_id = ${user} AND item_id = s.id) AS starred,
        (SELECT COUNT(*)::int FROM plays WHERE user_id = ${user} AND song_id = s.id) AS play_count,
        (SELECT rating FROM ratings WHERE user_id = ${user} AND item_id = s.id) AS rating
      FROM songs s
      JOIN albums al ON al.id = s.album_id
      JOIN artists ar ON ar.id = s.artist_id
      LEFT JOIN LATERAL (
        SELECT * FROM song_sources WHERE song_id = s.id ORDER BY lossless DESC, COALESCE(bitrate, 0) DESC LIMIT 1
      ) src ON TRUE`
  }

  private albumSelect(user: number) {
    return this.sql`
      SELECT al.id, al.name, al.artist_id, ar.name AS artist_name, al.year, al.genre, al.cover, al.created::float8 AS created,
        (SELECT COUNT(*)::int FROM songs WHERE album_id = al.id) AS song_count,
        (SELECT COALESCE(SUM(duration), 0)::int FROM songs WHERE album_id = al.id) AS duration,
        (SELECT at::float8 FROM stars WHERE user_id = ${user} AND item_id = al.id) AS starred,
        (SELECT COUNT(*)::int FROM plays p JOIN songs x ON x.id = p.song_id WHERE p.user_id = ${user} AND x.album_id = al.id) AS play_count,
        (SELECT rating FROM ratings WHERE user_id = ${user} AND item_id = al.id) AS rating
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id`
  }

  private artistSelect(user: number) {
    return this.sql`
      SELECT ar.id, ar.name, ar.sort_name, ar.cover,
        (SELECT COUNT(*)::int FROM albums WHERE artist_id = ar.id) AS album_count,
        (SELECT at::float8 FROM stars WHERE user_id = ${user} AND item_id = ar.id) AS starred,
        (SELECT rating FROM ratings WHERE user_id = ${user} AND item_id = ar.id) AS rating
      FROM artists ar`
  }

  private playlistSelect() {
    return this.sql`
      SELECT pl.id, pl.name, pl.owner_id, u.name AS owner, pl.comment, pl.public, pl.created::float8 AS created, pl.changed::float8 AS changed,
        (SELECT COUNT(*)::int FROM playlist_songs WHERE playlist_id = pl.id) AS song_count,
        (SELECT COALESCE(SUM(s.duration), 0)::int FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id WHERE ps.playlist_id = pl.id) AS duration
      FROM playlists pl JOIN users u ON u.id = pl.owner_id`
  }

  /* ---------------- Writing ---------------- */

  /** Add a song (or a new source of a song already in the catalog). Returns its id. */
  async upsertSong(input: SongInput): Promise<string> {
    const title = input.title.trim() || 'Unknown title'
    const artistName = input.artist.trim() || 'Unknown artist'
    const albumArtistName = input.albumArtist?.trim() || artistName
    const albumName = input.album?.trim() || title
    const artistId = artistIdFor(artistName)
    const albumArtistId = artistIdFor(albumArtistName)
    const albumId = albumIdFor(albumArtistId, albumName)
    const songId = songIdFor(albumId, title, input.disc ?? 1)
    const now = Date.now()
    const source = input.source

    await this.sql.begin(async (tx) => {
      for (const [id, name] of new Map([[artistId, artistName], [albumArtistId, albumArtistName]])) {
        await tx`INSERT INTO artists (id, name, sort_name) VALUES (${id}, ${name}, ${name.replace(ARTICLES, '')}) ON CONFLICT (id) DO NOTHING`
      }
      await tx`
        INSERT INTO albums (id, name, artist_id, year, genre, cover, created)
        VALUES (${albumId}, ${albumName}, ${albumArtistId}, ${input.year ?? null}, ${input.genre ?? null}, ${input.cover ?? null}, ${now})
        ON CONFLICT (id) DO UPDATE SET year = COALESCE(albums.year, EXCLUDED.year), genre = COALESCE(albums.genre, EXCLUDED.genre), cover = COALESCE(albums.cover, EXCLUDED.cover)`
      await tx`
        INSERT INTO songs (id, title, album_id, artist_id, track, disc, year, genre, duration, cover, tags, created)
        VALUES (${songId}, ${title}, ${albumId}, ${artistId}, ${input.track ?? null}, ${input.disc ?? null}, ${input.year ?? null},
          ${input.genre ?? null}, ${input.duration === undefined ? null : Math.round(input.duration)}, ${input.cover ?? null},
          (${JSON.stringify(input.tags ?? [])}::text)::jsonb, ${now})
        ON CONFLICT (id) DO UPDATE SET track = COALESCE(songs.track, EXCLUDED.track), year = COALESCE(songs.year, EXCLUDED.year),
          genre = COALESCE(songs.genre, EXCLUDED.genre), duration = COALESCE(songs.duration, EXCLUDED.duration), cover = COALESCE(songs.cover, EXCLUDED.cover)`
      await tx`
        INSERT INTO song_sources (song_id, provider, external_id, content_type, suffix, bitrate, sample_rate, bit_depth, channels, size, lossless)
        VALUES (${songId}, ${source.provider}, ${source.externalId}, ${source.contentType ?? null}, ${source.suffix ?? null},
          ${source.bitrate ? Math.round(source.bitrate) : null}, ${source.sampleRate ?? null}, ${source.bitDepth ?? null},
          ${source.channels ?? null}, ${source.size ?? null}, ${source.lossless ?? false})
        ON CONFLICT (song_id, provider, external_id) DO UPDATE SET content_type = EXCLUDED.content_type, suffix = EXCLUDED.suffix,
          bitrate = EXCLUDED.bitrate, sample_rate = EXCLUDED.sample_rate, bit_depth = EXCLUDED.bit_depth,
          channels = EXCLUDED.channels, size = EXCLUDED.size, lossless = EXCLUDED.lossless`
    })
    return songId
  }

  /** Replace a song's tags (e.g. from a tagging plugin). */
  async setTags(songId: string, tags: string[]) {
    await this.sql`UPDATE songs SET tags = (${JSON.stringify(tags)}::text)::jsonb WHERE id = ${songId}`
  }

  /** Drop a provider's sources (all, or all but those in `keep`), then songs and albums left without any. */
  async removeSources(provider: string, keep?: Set<string>): Promise<number> {
    return await this.sql.begin(async (tx) => {
      let removed: number
      if (keep) {
        const rows: { external_id: string }[] = await tx`SELECT DISTINCT external_id FROM song_sources WHERE provider = ${provider}`
        const gone = rows.map((row) => row.external_id).filter((id) => !keep.has(id))
        removed = 0
        for (let i = 0; i < gone.length; i += 500) {
          const result = await tx`DELETE FROM song_sources WHERE provider = ${provider} AND external_id IN ${tx(gone.slice(i, i + 500))}`
          removed += result.count
        }
      } else {
        removed = (await tx`DELETE FROM song_sources WHERE provider = ${provider}`).count
      }
      await tx`DELETE FROM songs s WHERE NOT EXISTS (SELECT 1 FROM song_sources WHERE song_id = s.id)`
      await tx`DELETE FROM albums al WHERE NOT EXISTS (SELECT 1 FROM songs WHERE album_id = al.id)`
      await tx`DELETE FROM artists ar WHERE NOT EXISTS (SELECT 1 FROM songs WHERE artist_id = ar.id) AND NOT EXISTS (SELECT 1 FROM albums WHERE artist_id = ar.id)`
      return removed
    })
  }

  /* ---------------- Reading ---------------- */

  async song(id: string, user = 0): Promise<SongRow | null> {
    const [row] = await this.sql`${this.songSelect(user)} WHERE s.id = ${id}`
    return row ?? null
  }

  /** Songs by id, in the order given (unknown ids are dropped). */
  async songs(ids: string[], user = 0): Promise<SongRow[]> {
    if (ids.length === 0) return []
    const rows: SongRow[] = await this.sql`${this.songSelect(user)} WHERE s.id IN ${this.sql([...new Set(ids)])}`
    const byId = new Map(rows.map((row) => [row.id, row]))
    return ids.map((id) => byId.get(id)).filter((row): row is SongRow => row !== undefined)
  }

  async sources(songId: string): Promise<SourceRow[]> {
    return await this.sql`SELECT *, size::float8 AS size FROM song_sources WHERE song_id = ${songId} ORDER BY lossless DESC, COALESCE(bitrate, 0) DESC`
  }

  async album(id: string, user = 0): Promise<AlbumRow | null> {
    const [row] = await this.sql`${this.albumSelect(user)} WHERE al.id = ${id}`
    return row ?? null
  }

  async albumSongs(albumId: string, user = 0): Promise<SongRow[]> {
    return await this.sql`${this.songSelect(user)} WHERE s.album_id = ${albumId} ORDER BY COALESCE(s.disc, 1), COALESCE(s.track, 9999), s.title`
  }

  async artist(id: string, user = 0): Promise<ArtistRow | null> {
    const [row] = await this.sql`${this.artistSelect(user)} WHERE ar.id = ${id}`
    return row ?? null
  }

  /** Artists that have albums, by name without leading articles. */
  async artists(user = 0): Promise<ArtistRow[]> {
    return await this.sql`${this.artistSelect(user)} WHERE EXISTS (SELECT 1 FROM albums WHERE artist_id = ar.id) ORDER BY lower(ar.sort_name)`
  }

  async artistAlbums(artistId: string, user = 0): Promise<AlbumRow[]> {
    return await this.sql`${this.albumSelect(user)} WHERE al.artist_id = ${artistId} ORDER BY COALESCE(al.year, 0) DESC, al.name`
  }

  /** Songs by an artist, most played on the whole server first. */
  async topSongs(artistName: string, count: number, user = 0): Promise<SongRow[]> {
    return await this.sql`
      ${this.songSelect(user)} WHERE lower(ar.name) = lower(${artistName})
      ORDER BY (SELECT COUNT(*) FROM plays WHERE song_id = s.id) DESC, s.created LIMIT ${count}`
  }

  async albumList(
    type: AlbumListType,
    options: { size: number; offset: number; fromYear?: number; toYear?: number; genre?: string },
    user = 0,
  ): Promise<AlbumRow[]> {
    const sql = this.sql
    let where = sql``
    let order = sql`lower(al.name)`
    switch (type) {
      case 'random':
        order = sql`random()`
        break
      case 'newest':
        order = sql`al.created DESC`
        break
      case 'frequent':
        where = sql`WHERE al.play_count > 0`
        order = sql`al.play_count DESC`
        break
      case 'recent':
        where = sql`WHERE al.play_count > 0`
        order = sql`(SELECT MAX(p.at) FROM plays p JOIN songs x ON x.id = p.song_id WHERE p.user_id = ${user} AND x.album_id = al.id) DESC`
        break
      case 'starred':
        where = sql`WHERE al.starred IS NOT NULL`
        order = sql`al.starred DESC`
        break
      case 'highest':
        where = sql`WHERE al.rating IS NOT NULL`
        order = sql`al.rating DESC`
        break
      case 'alphabeticalByArtist':
        order = sql`lower(al.artist_name), lower(al.name)`
        break
      case 'byYear': {
        const from = options.fromYear ?? 0
        const to = options.toYear ?? 9999
        where = sql`WHERE al.year BETWEEN ${Math.min(from, to)} AND ${Math.max(from, to)}`
        order = from <= to ? sql`al.year, al.name` : sql`al.year DESC, al.name`
        break
      }
      case 'byGenre':
        where = sql`WHERE lower(al.genre) = lower(${options.genre ?? ''})`
        break
    }
    // Wrapped, so the computed columns can be filtered and sorted on.
    return await sql`SELECT * FROM (${this.albumSelect(user)}) al ${where} ORDER BY ${order} LIMIT ${options.size} OFFSET ${options.offset}`
  }

  async randomSongs(options: { size: number; genre?: string; fromYear?: number; toYear?: number }, user = 0): Promise<SongRow[]> {
    const sql = this.sql
    const genre = options.genre ? sql`AND lower(s.genre) = lower(${options.genre})` : sql``
    const from = options.fromYear !== undefined ? sql`AND s.year >= ${options.fromYear}` : sql``
    const to = options.toYear !== undefined ? sql`AND s.year <= ${options.toYear}` : sql``
    return await sql`${this.songSelect(user)} WHERE TRUE ${genre} ${from} ${to} ORDER BY random() LIMIT ${options.size}`
  }

  async songsByGenre(genre: string, count: number, offset: number, user = 0): Promise<SongRow[]> {
    return await this.sql`${this.songSelect(user)} WHERE lower(s.genre) = lower(${genre}) ORDER BY s.title LIMIT ${count} OFFSET ${offset}`
  }

  async genres(): Promise<{ value: string; songCount: number; albumCount: number }[]> {
    return await this.sql`
      SELECT MIN(genre) AS value, COUNT(*)::int AS "songCount", COUNT(DISTINCT album_id)::int AS "albumCount"
      FROM songs WHERE genre IS NOT NULL AND genre <> '' GROUP BY lower(genre) ORDER BY lower(MIN(genre))`
  }

  /**
   * Every word has to match somewhere (title, artist or album), so "queen bohemian
   * rhapsody" finds the song; whole-query title matches come first.
   */
  async search(query: string, counts: { artist: [number, number]; album: [number, number]; song: [number, number] }, user = 0) {
    const text = query.trim().replace(/^"|"$/g, '')
    const whole = like(text)
    const words = this.sql.array(text.split(/\s+/).filter(Boolean).map(like).concat(text ? [] : ['%']), 'text')
    const [artists, albums, songs] = await Promise.all([
      counts.artist[0] > 0
        ? this.sql`${this.artistSelect(user)} WHERE ar.name ILIKE ALL(${words}) ORDER BY (ar.name ILIKE ${whole}) DESC, lower(ar.sort_name) LIMIT ${counts.artist[0]} OFFSET ${counts.artist[1]}`
        : [],
      counts.album[0] > 0
        ? this.sql`${this.albumSelect(user)} WHERE concat_ws(' ', al.name, ar.name) ILIKE ALL(${words}) ORDER BY (al.name ILIKE ${whole}) DESC, lower(al.name) LIMIT ${counts.album[0]} OFFSET ${counts.album[1]}`
        : [],
      counts.song[0] > 0
        ? this.sql`${this.songSelect(user)} WHERE concat_ws(' ', s.title, ar.name, al.name) ILIKE ALL(${words}) ORDER BY (s.title ILIKE ${whole}) DESC, lower(s.title) LIMIT ${counts.song[0]} OFFSET ${counts.song[1]}`
        : [],
    ])
    return { artists: artists as ArtistRow[], albums: albums as AlbumRow[], songs: songs as SongRow[] }
  }

  async counts(): Promise<{ songs: number; albums: number; artists: number }> {
    const [row] = await this.sql`SELECT (SELECT COUNT(*)::int FROM songs) AS songs, (SELECT COUNT(*)::int FROM albums) AS albums, (SELECT COUNT(*)::int FROM artists) AS artists`
    return row
  }

  /** Which kind of item an id is, from its prefix. */
  kindOf(id: string): 'song' | 'album' | 'artist' | 'playlist' | null {
    if (id.startsWith('so-')) return 'song'
    if (id.startsWith('al-')) return 'album'
    if (id.startsWith('ar-')) return 'artist'
    if (id.startsWith('pl-')) return 'playlist'
    return null
  }

  /** The artwork reference for any item id (falling back from song to album, artist to album). */
  async coverOf(id: string): Promise<string | null> {
    let row
    switch (this.kindOf(id)) {
      case 'song':
        ;[row] = await this.sql`SELECT COALESCE(s.cover, al.cover) AS cover FROM songs s JOIN albums al ON al.id = s.album_id WHERE s.id = ${id}`
        break
      case 'album':
        ;[row] = await this.sql`SELECT COALESCE(cover, (SELECT cover FROM songs WHERE album_id = ${id} AND cover IS NOT NULL LIMIT 1)) AS cover FROM albums WHERE id = ${id}`
        break
      case 'artist':
        ;[row] = await this.sql`SELECT COALESCE(cover, (SELECT cover FROM albums WHERE artist_id = ${id} AND cover IS NOT NULL LIMIT 1)) AS cover FROM artists WHERE id = ${id}`
        break
    }
    return row?.cover ?? null
  }

  /* ---------------- Per-user annotations ---------------- */

  async star(user: number, ids: string[], starred: boolean) {
    await this.sql.begin(async (tx) => {
      for (const id of ids) {
        const kind = this.kindOf(id)
        if (!kind || kind === 'playlist') continue
        if (starred) await tx`INSERT INTO stars (user_id, kind, item_id, at) VALUES (${user}, ${kind}, ${id}, ${Date.now()}) ON CONFLICT DO NOTHING`
        else await tx`DELETE FROM stars WHERE user_id = ${user} AND item_id = ${id}`
      }
    })
  }

  async starred(user: number) {
    const rows: { kind: string; item_id: string }[] = await this.sql`SELECT kind, item_id FROM stars WHERE user_id = ${user} ORDER BY at DESC`
    const ids = (kind: string) => rows.filter((row) => row.kind === kind).map((row) => row.item_id)
    const artists = ids('artist').length ? await this.sql`${this.artistSelect(user)} WHERE ar.id IN ${this.sql(ids('artist'))}` : []
    const albums = ids('album').length ? await this.sql`${this.albumSelect(user)} WHERE al.id IN ${this.sql(ids('album'))}` : []
    return { artists: artists as ArtistRow[], albums: albums as AlbumRow[], songs: await this.songs(ids('song'), user) }
  }

  async setRating(user: number, id: string, rating: number) {
    if (rating === 0) await this.sql`DELETE FROM ratings WHERE user_id = ${user} AND item_id = ${id}`
    else await this.sql`INSERT INTO ratings (user_id, item_id, rating) VALUES (${user}, ${id}, ${rating}) ON CONFLICT (user_id, item_id) DO UPDATE SET rating = EXCLUDED.rating`
  }

  async scrobble(user: number, songId: string, at = Date.now()) {
    await this.sql`INSERT INTO plays (user_id, song_id, at) VALUES (${user}, ${songId}, ${at})`
  }

  /** A user's recent plays, newest first. */
  async recentPlays(user: number, limit: number): Promise<{ song_id: string; at: number }[]> {
    return await this.sql`SELECT song_id, at::float8 AS at FROM plays WHERE user_id = ${user} ORDER BY at DESC LIMIT ${limit}`
  }

  /** Songs other listeners of `songId` also played, by how many shared listeners. */
  async coPlayed(songId: string, limit: number): Promise<{ song_id: string; score: number }[]> {
    return await this.sql`
      SELECT p2.song_id, COUNT(DISTINCT p2.user_id)::int AS score
      FROM plays p1 JOIN plays p2 ON p2.user_id = p1.user_id AND p2.song_id <> p1.song_id
      WHERE p1.song_id = ${songId} GROUP BY p2.song_id ORDER BY score DESC LIMIT ${limit}`
  }

  /** Song ids sharing artist, genre, tags or era with `song`, best matches first. */
  async similarTo(song: SongRow, limit: number): Promise<string[]> {
    const tags = this.sql.array(song.tags.length ? song.tags : [''], 'text')
    const rows: { id: string }[] = await this.sql`
      SELECT s.id FROM songs s WHERE s.id <> ${song.id} AND s.album_id <> ${song.album_id}
      ORDER BY
        (CASE WHEN s.artist_id = ${song.artist_id} THEN 2 ELSE 0 END)
        + (CASE WHEN ${song.genre}::text IS NOT NULL AND lower(s.genre) = lower(${song.genre}::text) THEN 3 ELSE 0 END)
        + (SELECT COUNT(*) FROM jsonb_array_elements_text(s.tags) t WHERE t = ANY(${tags})) * 2
        + (CASE WHEN ${song.year}::int IS NOT NULL AND s.year BETWEEN ${song.year}::int - 5 AND ${song.year}::int + 5 THEN 1 ELSE 0 END) DESC,
        random()
      LIMIT ${limit}`
    return rows.map((row) => row.id)
  }

  /* ---------------- Playlists ---------------- */

  async playlists(user: number): Promise<PlaylistRow[]> {
    return await this.sql`${this.playlistSelect()} WHERE pl.owner_id = ${user} OR pl.public ORDER BY pl.changed DESC`
  }

  async playlist(id: string): Promise<PlaylistRow | null> {
    const [row] = await this.sql`${this.playlistSelect()} WHERE pl.id = ${id}`
    return row ?? null
  }

  async playlistSongIds(id: string): Promise<string[]> {
    const rows: { song_id: string }[] = await this.sql`SELECT song_id FROM playlist_songs WHERE playlist_id = ${id} ORDER BY position`
    return rows.map((row) => row.song_id)
  }

  async createPlaylist(owner: number, name: string, songIds: string[]): Promise<string> {
    const id = `pl-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const now = Date.now()
    await this.sql`INSERT INTO playlists (id, name, owner_id, created, changed) VALUES (${id}, ${name}, ${owner}, ${now}, ${now})`
    await this.setPlaylistSongs(id, songIds)
    return id
  }

  async setPlaylistSongs(id: string, songIds: string[]) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM playlist_songs WHERE playlist_id = ${id}`
      for (const [position, song] of songIds.entries()) await tx`INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (${id}, ${position}, ${song})`
      await tx`UPDATE playlists SET changed = ${Date.now()} WHERE id = ${id}`
    })
  }

  async updatePlaylist(id: string, fields: { name?: string; comment?: string; public?: boolean }) {
    await this.sql`
      UPDATE playlists SET name = COALESCE(${fields.name ?? null}, name), comment = COALESCE(${fields.comment ?? null}, comment),
        public = COALESCE(${fields.public ?? null}::boolean, public), changed = ${Date.now()}
      WHERE id = ${id}`
  }

  async deletePlaylist(id: string) {
    await this.sql`DELETE FROM playlists WHERE id = ${id}`
  }

  /* ---------------- Play queues and bookmarks ---------------- */

  async playQueue(user: number): Promise<PlayQueueRow | null> {
    const [row] = await this.sql`SELECT song_ids, current_index, position_ms::float8 AS position_ms, changed::float8 AS changed, changed_by FROM play_queues WHERE user_id = ${user}`
    return row ?? null
  }

  /** Save (or with no songs, clear) a user's play queue. */
  async savePlayQueue(user: number, queue: { songIds: string[]; currentIndex: number | null; positionMs: number; changedBy: string }) {
    if (queue.songIds.length === 0) {
      await this.sql`DELETE FROM play_queues WHERE user_id = ${user}`
      return
    }
    await this.sql`
      INSERT INTO play_queues (user_id, song_ids, current_index, position_ms, changed, changed_by)
      VALUES (${user}, ${this.sql.array(queue.songIds, 'text')}, ${queue.currentIndex}, ${Math.max(0, Math.round(queue.positionMs))}, ${Date.now()}, ${queue.changedBy.slice(0, 100)})
      ON CONFLICT (user_id) DO UPDATE SET song_ids = EXCLUDED.song_ids, current_index = EXCLUDED.current_index,
        position_ms = EXCLUDED.position_ms, changed = EXCLUDED.changed, changed_by = EXCLUDED.changed_by`
  }

  async bookmarks(user: number): Promise<BookmarkRow[]> {
    return await this.sql`SELECT song_id, position_ms::float8 AS position_ms, comment, created::float8 AS created, changed::float8 AS changed FROM bookmarks WHERE user_id = ${user} ORDER BY changed DESC`
  }

  async saveBookmark(user: number, songId: string, positionMs: number, comment?: string) {
    const now = Date.now()
    await this.sql`
      INSERT INTO bookmarks (user_id, song_id, position_ms, comment, created, changed)
      VALUES (${user}, ${songId}, ${Math.max(0, Math.round(positionMs))}, ${comment ?? null}, ${now}, ${now})
      ON CONFLICT (user_id, song_id) DO UPDATE SET position_ms = EXCLUDED.position_ms, comment = EXCLUDED.comment, changed = EXCLUDED.changed`
  }

  async deleteBookmark(user: number, songId: string) {
    await this.sql`DELETE FROM bookmarks WHERE user_id = ${user} AND song_id = ${songId}`
  }
}
