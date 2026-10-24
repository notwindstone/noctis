/*
 * Server charts: the server half (see docs/SERVER-PLUGINS.md).
 *
 *   POST /api/plugins/play-stats/plays   { song: { id, title, artists, source, thumbnail } }
 *   GET  /api/plugins/play-stats/top     the 50 most played songs
 */

export default function ({ Plugin, Noctis }) {
  const { t } = Noctis.packages.elysia

  /** "<source>:<id>" → { song, plays, lastPlayed } */
  const keyOf = (song) => `song:${song.source ?? 'youtube-music'}:${song.id}`

  const Song = t.Object({
    id: t.String({ minLength: 1, maxLength: 200 }),
    title: t.String({ maxLength: 300 }),
    artists: t.Array(t.Object({ name: t.String({ maxLength: 200 }), id: t.Optional(t.String({ maxLength: 200 })) }), { maxItems: 20 }),
    source: t.Optional(t.String({ maxLength: 64 })),
    thumbnail: t.Optional(t.String({ maxLength: 2000 })),
  })

  function attach() {
    Plugin.routes((app) =>
      app
        .post('/plays', { body: t.Object({ song: Song }) }, ({ body }) => {
          const key = keyOf(body.song)
          const entry = Plugin.storage.get(key, { song: body.song, plays: 0 })
          Plugin.storage.set(key, { song: body.song, plays: entry.plays + 1, lastPlayed: Date.now() })
          return { plays: entry.plays + 1 }
        })
        .get('/top', () =>
          Plugin.storage
            .keys('song:')
            .map((key) => Plugin.storage.get(key))
            .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed)
            .slice(0, 50),
        ),
    )
  }

  Plugin.subscribe('lifecycle::disable', () => Plugin.removeRoutes())
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  Plugin.log(`Counting plays (${Plugin.storage.keys('song:').length} songs so far)`)
}
