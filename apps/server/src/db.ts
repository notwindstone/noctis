import { SQL } from 'bun'

/**
 * PostgreSQL: the music catalog, users and groups, play queues and bookmarks, and plugin
 * storage. (Sessions live in Redis, see src/sessions.ts.) Migrations run forward at
 * startup, recorded in schema_migrations.
 *
 * Timestamps are milliseconds since the epoch (BIGINT), like everywhere else in Noctis.
 */

const MIGRATIONS: string[] = [
  // 1: everything
  `
  CREATE TABLE plugin_data (
    plugin TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (plugin, key)
  );

  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX users_name ON users (lower(name));

  -- Groups carry permissions; a user has the union of their groups' permissions.
  CREATE TABLE groups (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    permissions TEXT[] NOT NULL DEFAULT '{}',
    builtin BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE user_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );

  CREATE TABLE artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    cover TEXT
  );
  CREATE TABLE albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    artist_id TEXT NOT NULL REFERENCES artists(id),
    year INTEGER,
    genre TEXT,
    cover TEXT,
    created BIGINT NOT NULL
  );
  CREATE INDEX albums_artist ON albums (artist_id);
  CREATE TABLE songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    album_id TEXT NOT NULL REFERENCES albums(id),
    artist_id TEXT NOT NULL REFERENCES artists(id),
    track INTEGER,
    disc INTEGER,
    year INTEGER,
    genre TEXT,
    duration INTEGER,
    cover TEXT,
    tags JSONB NOT NULL DEFAULT '[]',
    created BIGINT NOT NULL
  );
  CREATE INDEX songs_album ON songs (album_id);
  CREATE INDEX songs_artist ON songs (artist_id);

  -- Where a song can be played from: a provider (a plugin) and the song's id there.
  CREATE TABLE song_sources (
    song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    content_type TEXT,
    suffix TEXT,
    bitrate INTEGER,
    sample_rate INTEGER,
    bit_depth INTEGER,
    channels INTEGER,
    size BIGINT,
    lossless BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (song_id, provider, external_id)
  );
  CREATE INDEX song_sources_provider ON song_sources (provider, external_id);

  CREATE TABLE stars (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    at BIGINT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE TABLE ratings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE TABLE plays (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    at BIGINT NOT NULL
  );
  CREATE INDEX plays_user ON plays (user_id, at DESC);
  CREATE INDEX plays_song ON plays (song_id);

  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment TEXT,
    public BOOLEAN NOT NULL DEFAULT FALSE,
    created BIGINT NOT NULL,
    changed BIGINT NOT NULL
  );
  CREATE TABLE playlist_songs (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    song_id TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
  );

  -- One saved play queue per user (OpenSubsonic savePlayQueue / getPlayQueue).
  CREATE TABLE play_queues (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    song_ids TEXT[] NOT NULL,
    current_index INTEGER,
    position_ms BIGINT NOT NULL DEFAULT 0,
    changed BIGINT NOT NULL,
    changed_by TEXT NOT NULL DEFAULT ''
  );
  -- A position inside a song (createBookmark / getBookmarks).
  CREATE TABLE bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    position_ms BIGINT NOT NULL,
    comment TEXT,
    created BIGINT NOT NULL,
    changed BIGINT NOT NULL,
    PRIMARY KEY (user_id, song_id)
  );
  `,
]

export type Database = SQL

export async function openDatabase(url: string): Promise<Database> {
  const sql = new SQL(url, { max: 20 })
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied BIGINT NOT NULL)`
  const [{ version }] = await sql`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`
  for (let i = version; i < MIGRATIONS.length; i++) {
    await sql.begin(async (tx) => {
      await tx.unsafe(MIGRATIONS[i])
      await tx`INSERT INTO schema_migrations (version, applied) VALUES (${i + 1}, ${Date.now()})`
    })
  }
  return sql
}
