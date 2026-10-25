import type { AlbumRow, ArtistRow, PlaylistRow, SongRow } from '../catalog/catalog'

/**
 * Catalog rows → OpenSubsonic objects (Child, AlbumID3, ArtistID3, Playlist). Every
 * item's coverArt is its own id; getCoverArt resolves it (song → album → artist).
 */

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined)

export function songToChild(row: SongRow) {
  return {
    id: row.id,
    parent: row.album_id,
    isDir: false,
    title: row.title,
    album: row.album_name,
    artist: row.artist_name,
    track: row.track ?? undefined,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    coverArt: row.id,
    size: row.size ?? undefined,
    contentType: row.content_type ?? undefined,
    suffix: row.suffix ?? undefined,
    duration: row.duration ?? undefined,
    bitRate: row.bitrate ?? undefined,
    bitDepth: row.bit_depth ?? undefined,
    samplingRate: row.sample_rate ?? undefined,
    channelCount: row.channels ?? undefined,
    discNumber: row.disc ?? undefined,
    created: iso(row.created),
    starred: iso(row.starred),
    playCount: row.play_count,
    userRating: row.rating ?? undefined,
    albumId: row.album_id,
    artistId: row.artist_id,
    type: 'music',
    mediaType: 'song',
    isVideo: false,
    // OpenSubsonic
    displayArtist: row.artist_name,
    artists: [{ id: row.artist_id, name: row.artist_name }],
    genres: row.genre ? [{ name: row.genre }] : [],
    moods: row.tags,
  }
}

export function albumToID3(row: AlbumRow) {
  return {
    id: row.id,
    name: row.name,
    artist: row.artist_name,
    artistId: row.artist_id,
    coverArt: row.id,
    songCount: row.song_count,
    duration: row.duration,
    created: iso(row.created),
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    starred: iso(row.starred),
    playCount: row.play_count,
    userRating: row.rating ?? undefined,
    // OpenSubsonic
    displayArtist: row.artist_name,
    artists: [{ id: row.artist_id, name: row.artist_name }],
    genres: row.genre ? [{ name: row.genre }] : [],
  }
}

/** For getAlbumList (the folder-based variant): an album as a directory Child. */
export function albumToChild(row: AlbumRow) {
  return { id: row.id, parent: row.artist_id, isDir: true, title: row.name, album: row.name, artist: row.artist_name, year: row.year ?? undefined, genre: row.genre ?? undefined, coverArt: row.id, starred: iso(row.starred), playCount: row.play_count, created: iso(row.created) }
}

export function artistToID3(row: ArtistRow) {
  return {
    id: row.id,
    name: row.name,
    coverArt: row.id,
    albumCount: row.album_count,
    starred: iso(row.starred),
    userRating: row.rating ?? undefined,
  }
}

export function playlistToSubsonic(row: PlaylistRow) {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment ?? undefined,
    owner: row.owner,
    public: row.public,
    songCount: row.song_count,
    duration: row.duration,
    created: iso(row.created),
    changed: iso(row.changed),
    coverArt: row.id,
  }
}

const ignoredArticles = 'The El La Los Las Le Les'

/** Artists grouped under their first letter, as getArtists/getIndexes return them. */
export function indexArtists(rows: ArtistRow[]) {
  const groups = new Map<string, ReturnType<typeof artistToID3>[]>()
  for (const row of rows) {
    const first = row.sort_name.charAt(0).toUpperCase()
    const letter = /[A-Z]/.test(first) ? first : '#'
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter)!.push(artistToID3(row))
  }
  return { ignoredArticles, index: [...groups.entries()].map(([name, artist]) => ({ name, artist })) }
}
