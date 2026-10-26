/**
 * MusicBrainz: an indexer, as a server plugin. It fills the catalog with what
 * MusicBrainz knows (titles, artists, albums, track numbers, lengths, tags, covers from
 * the Cover Art Archive) and no audio: the songs it adds are played by clients with
 * their own services (YouTube Music, SoundCloud…, through "Play from"), or by any
 * provider that has the same song (a local file with the same artist, album and title
 * becomes the same song, now with its MusicBrainz id as a source).
 *
 * - Lazily: an OpenSubsonic search (search3/search2) of three letters or more also
 *   searches MusicBrainz first, briefly (MUSICBRAINZ_SEARCH_TIMEOUT_MS), and adds what
 *   it finds, so results include it. A query is looked up once a week at most.
 *   MUSICBRAINZ_INDEX_SEARCHES=false turns this off.
 * - On request: POST /api/plugins/musicbrainz/import { release } or { artist } (an
 *   artist's official albums), with the musicbrainz.import permission (admins).
 * - Politely: MusicBrainz allows one request a second, with a User-Agent saying who's
 *   asking (MUSICBRAINZ_CONTACT: a URL or e-mail for the instance). Requests queue.
 *
 * Sources are "musicbrainz:<recording MBID>". The provider can't stream (there's
 * nothing to stream), so OpenSubsonic apps can't play songs known only from here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Scope = { Plugin: any; Noctis: any }

const API = 'https://musicbrainz.org/ws/2'
const COVERS = 'https://coverartarchive.org'
const PROVIDER = 'musicbrainz'
const WEEK = 7 * 24 * 3600_000

interface ArtistCredit {
  name: string
  joinphrase?: string
  artist: { id: string; name: string }
}

interface Release {
  id: string
  title: string
  status?: string
  date?: string
  'artist-credit'?: ArtistCredit[]
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] }
  media?: { position?: number; track?: { number?: string; position?: number }[]; tracks?: Track[] }[]
}

interface Recording {
  id: string
  title: string
  length?: number | null
  'artist-credit'?: ArtistCredit[]
  releases?: Release[]
  tags?: { name: string; count: number }[]
  genres?: { name: string; count: number }[]
  'first-release-date'?: string
  score?: number
}

interface Track {
  position?: number
  number?: string
  title: string
  length?: number | null
  recording: Recording
  'artist-credit'?: ArtistCredit[]
}

const credit = (credits: ArtistCredit[] | undefined) => (credits ?? []).map((item) => `${item.name}${item.joinphrase ?? ''}`).join('').trim()
const yearOf = (date: string | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined)
const normalize = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Officially released recordings. (Not "NOT secondarytype:live": a recording's fields
 * cover all its releases, so that would drop every original that's also on a live or
 * compilation album. Which release to show is picked afterwards, by releaseRank.)
 */
const OFFICIAL = 'status:official'

const wordsOf = (text: string) => normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)

/**
 * How far a result is from what was searched: words in its title and artist that the
 * search didn't have ("Cover", "Tribute", "remix", another artist). Null if it misses
 * a searched word. MusicBrainz ranks "artist title" searches loosely; this keeps covers
 * and tributes below the song itself.
 */
function distance(searched: string[], recording: Recording): number | null {
  const title = wordsOf(recording.title)
  const artist = wordsOf(credit(recording['artist-credit']))
  const have = new Set([...title, ...artist])
  if (!searched.every((word) => have.has(word) || [...have].some((other) => other.startsWith(word)))) return null
  const wanted = new Set(searched)
  return title.filter((word) => !wanted.has(word)).length + artist.filter((word) => !wanted.has(word)).length * 0.5
}

/**
 * Lucene for "artist title" (or "title artist") as people type it: every way to split
 * the words into an artist and a title, as phrases, boosted; and, as a fallback, each
 * word in the title or the artist.
 */
function searchQuery(text: string): string {
  const words = wordsOf(text).slice(0, 8)
  if (words.length === 0) return ''
  const splits: string[] = []
  if (words.length <= 6) {
    for (let i = 1; i < words.length; i++) {
      const first = words.slice(0, i).join(' ')
      const rest = words.slice(i).join(' ')
      splits.push(`(artist:"${first}" AND recording:"${rest}")^4`, `(recording:"${first}" AND artist:"${rest}")^4`)
    }
  }
  const loose = `(${words.map((word) => `(recording:${word} OR artist:${word})`).join(' AND ')})`
  return [...splits, `recording:"${words.join(' ')}"^2`, loose].join(' OR ')
}

/** Studio albums first, then singles and EPs, then compilations and live; earliest first. */
function releaseRank(release: Release): number {
  const group = release['release-group']
  const secondary = group?.['secondary-types']?.length ?? 0
  const primary = group?.['primary-type']
  return (release.status === 'Official' ? 0 : 100) + (secondary > 0 ? 20 : 0) + (primary === 'Album' ? 0 : primary === 'EP' ? 5 : primary === 'Single' ? 8 : 12)
}

function bestRelease(recording: Recording): Release | undefined {
  return [...(recording.releases ?? [])].sort((a, b) => releaseRank(a) - releaseRank(b) || (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0]
}

/**
 * Of several recordings of one song, the original: on a studio album rather than a
 * live or compilation one, released first, and on more releases (re-releases of the
 * album version) rather than fewer.
 */
function compareRecordings(a: Recording, b: Recording): number {
  const releaseA = bestRelease(a)
  const releaseB = bestRelease(b)
  const rank = (release: Release | undefined) => (release ? releaseRank(release) : 1000)
  const earliest = (recording: Recording) => recording['first-release-date'] || (recording.releases ?? []).map((release) => release.date ?? '9999').sort()[0] || '9999'
  return rank(releaseA) - rank(releaseB) || earliest(a).slice(0, 4).localeCompare(earliest(b).slice(0, 4)) || (b.releases?.length ?? 0) - (a.releases?.length ?? 0)
}

export default async function musicbrainz({ Plugin, Noctis }: Scope) {
  const { t } = Noctis.packages.elysia
  const { catalog, auth } = Noctis

  const contact = process.env.MUSICBRAINZ_CONTACT || 'https://github.com/notwindstone/noctis'
  const userAgent = `Noctis/${Noctis.version} ( ${contact} )`
  const indexSearches = !/^(0|false|no|off)$/i.test(process.env.MUSICBRAINZ_INDEX_SEARCHES ?? 'true')
  const searchTimeout = Number(process.env.MUSICBRAINZ_SEARCH_TIMEOUT_MS ?? 2500)

  const status = { requests: 0, indexed: 0, queued: 0, importing: null as string | null, lastError: null as string | null }

  /* ---------------- One request a second ---------------- */

  let chain: Promise<unknown> = Promise.resolve()
  let last = 0

  function mb<T>(path: string, params: Record<string, string>): Promise<T> {
    status.queued++
    const run = async (): Promise<T> => {
      const wait = last + 1100 - Date.now()
      if (wait > 0) await Bun.sleep(wait)
      const url = new URL(`${API}/${path}`)
      for (const [key, value] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(key, value)
      for (let attempt = 0; ; attempt++) {
        last = Date.now()
        status.requests++
        const response = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' } })
        // 503: over the rate limit (MusicBrainz's is shared by everyone on an IP, and sometimes global); back off and retry.
        if (response.status === 503 && attempt < 5) {
          const after = Number(response.headers.get('retry-after'))
          await Bun.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * 2 ** attempt)
          continue
        }
        if (!response.ok) throw new Error(`MusicBrainz answered HTTP ${response.status} for ${path}`)
        return (await response.json()) as T
      }
    }
    const result = chain.then(run, run).finally(() => status.queued--)
    chain = result.catch(() => {})
    return result
  }

  /* ---------------- Into the catalog ---------------- */

  async function indexRecording(recording: Recording, release = bestRelease(recording), track?: { number?: string; position?: number; disc?: number }) {
    const artist = credit(recording['artist-credit']) || 'Unknown artist'
    const group = release?.['release-group']
    const tags = [...(recording.genres ?? []), ...(recording.tags ?? [])]
      .sort((a, b) => b.count - a.count)
      .map((tag) => tag.name)
      .filter((name, index, all) => all.indexOf(name) === index)
      .slice(0, 8)
    const position = track?.position ?? release?.media?.[0]?.track?.[0]?.position ?? Number(release?.media?.[0]?.track?.[0]?.number)
    await catalog.upsertSong({
      title: recording.title,
      artist,
      album: release?.title,
      albumArtist: credit(release?.['artist-credit']) || artist,
      track: Number.isFinite(position) ? position : undefined,
      disc: track?.disc ?? release?.media?.[0]?.position,
      year: yearOf(release?.date) ?? yearOf(recording['first-release-date']),
      duration: recording.length ? recording.length / 1000 : undefined,
      cover: group ? `${PROVIDER}:release-group/${group.id}` : release ? `${PROVIDER}:release/${release.id}` : undefined,
      tags,
      source: { provider: PROVIDER, externalId: recording.id },
    })
    status.indexed++
  }

  /** Search MusicBrainz and index the best match per song (one artist + title, its most "original" release). */
  async function indexSearch(text: string): Promise<number> {
    const query = searchQuery(text)
    if (!query) return 0
    // Popular songs have dozens of bootlegs ranked like the original: look among
    // official releases first, and at everything only if that finds little.
    const searched = wordsOf(text)
    const close = (list: Recording[]) => list.filter((item) => distance(searched, item) !== null)
    let recordings = close((await mb<{ recordings?: Recording[] }>('recording', { query: `(${query}) AND ${OFFICIAL}`, limit: '50' })).recordings ?? [])
    if (new Set(recordings.map((item) => normalize(item.title))).size < 5) {
      recordings = [...recordings, ...close((await mb<{ recordings?: Recording[] }>('recording', { query, limit: '50' })).recordings ?? [])]
    }
    // No song matches exactly: the search may be an artist's name ("aphex twin"). Then
    // their songs are what's wanted, not songs that happen to be called that.
    let byArtist = false
    if (!recordings.some((item) => distance(searched, item) === 0)) {
      const songs = await artistSongs(text)
      if (songs.length > 0) {
        recordings = songs
        byArtist = true
      }
    }
    const best = new Map<string, Recording>()
    for (const recording of recordings) {
      const key = `${normalize(credit(recording['artist-credit']))}|${normalize(recording.title)}`
      const current = best.get(key)
      if (!current || compareRecordings(recording, current) < 0) best.set(key, recording)
    }
    const ranked = [...best.values()].sort((a, b) => distance(searched, a)! - distance(searched, b)! || (b.score ?? 0) - (a.score ?? 0) || compareRecordings(a, b))
    // With the song itself found, covers and tributes ("Creep (Radiohead cover)") aren't what was asked for.
    const closest = ranked.length > 0 ? distance(searched, ranked[0])! : 0
    const wanted = byArtist
      ? [...best.values()].sort(compareRecordings).slice(0, 25)
      : ranked.filter((item) => distance(searched, item)! <= closest + 1.5).slice(0, 10)
    for (const recording of wanted) await indexRecording(recording)
    return wanted.length
  }

  /** If `text` is an artist's name, their officially released songs (as many as one request brings). */
  async function artistSongs(text: string): Promise<Recording[]> {
    const phrase = wordsOf(text).join(' ')
    const artists = (await mb<{ artists?: { id: string; name: string; score?: number }[] }>('artist', { query: `artist:"${phrase}"`, limit: '3' })).artists ?? []
    const artist = artists.find((item) => wordsOf(item.name).join(' ') === phrase)
    if (!artist) return []
    return (await mb<{ recordings?: Recording[] }>('recording', { query: `arid:${artist.id} AND ${OFFICIAL}`, limit: '50' })).recordings ?? []
  }

  async function importRelease(id: string): Promise<number> {
    const release = await mb<Release & { media: { position?: number; tracks?: Track[] }[] }>(`release/${id}`, { inc: 'recordings artist-credits release-groups tags genres' })
    let count = 0
    for (const medium of release.media ?? []) {
      for (const track of medium.tracks ?? []) {
        const recording = { ...track.recording, title: track.recording.title || track.title, 'artist-credit': track.recording['artist-credit'] ?? track['artist-credit'] }
        await indexRecording(recording, release, { position: track.position, disc: medium.position })
        count++
      }
    }
    return count
  }

  /** An artist's official studio albums: one release per release group, the earliest. */
  async function importArtist(id: string): Promise<number> {
    const body = await mb<{ releases?: Release[] }>('release', { artist: id, type: 'album', status: 'official', inc: 'release-groups', limit: '100' })
    const groups = new Map<string, Release>()
    for (const release of body.releases ?? []) {
      const group = release['release-group']
      if (!group || (group['secondary-types']?.length ?? 0) > 0) continue
      const current = groups.get(group.id)
      if (!current || (release.date ?? '9999') < (current.date ?? '9999')) groups.set(group.id, release)
    }
    let count = 0
    for (const release of groups.values()) count += await importRelease(release.id)
    return count
  }

  /* ---------------- Provider: covers only ---------------- */

  const missingCovers = new Set<string>()

  Plugin.defineProvider(PROVIDER, {
    name: 'MusicBrainz',
    // No stream(): MusicBrainz has metadata, not audio.
    async cover(reference: string) {
      const path = reference.slice(PROVIDER.length + 1)
      if (!/^release(-group)?\/[0-9a-f-]{36}$/.test(path) || missingCovers.has(path)) return null
      const response = await fetch(`${COVERS}/${path}/front-500`, { headers: { 'user-agent': userAgent }, redirect: 'follow' })
      if (response.ok) return response
      if (response.status === 404) missingCovers.add(path)
      return null
    },
  })

  /* ---------------- Lazy indexing on search ---------------- */

  const SEARCHES = new Set(['search3', 'search2'])

  async function onSearch({ endpoint, params }: { endpoint: string; params: Map<string, string[]> }) {
    if (!indexSearches || !SEARCHES.has(endpoint)) return
    const text = (params.get('query')?.[0] ?? '').replace(/^"|"$/g, '').trim()
    if (text.length < 3) return
    const key = `query:${normalize(text).slice(0, 200)}`
    if (Date.now() - (await Plugin.storage.get(key, 0)) < WEEK) return
    await Plugin.storage.set(key, Date.now())

    // Wait briefly so this search already shows what MusicBrainz has; slower lookups finish in the background.
    const lookup = indexSearch(text).catch((error: Error) => {
      status.lastError = error.message
      Plugin.warn(`Searching MusicBrainz for "${text}" failed: ${error.message}`)
      void Plugin.storage.remove(key)
      return 0
    })
    await Promise.race([lookup, Bun.sleep(searchTimeout)])
  }

  Plugin.subscribe('hook::onSubsonic::before', onSearch)

  /* ---------------- Routes ---------------- */

  Plugin.permissions.define('musicbrainz.import', 'Import releases and artists from MusicBrainz into the catalog')

  const MBID = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })

  Plugin.routes((app: any) =>
    app
      .get('/status', () => ({ ...status, indexSearches, userAgent }))
      .post(
        '/import',
        { body: t.Object({ release: t.Optional(MBID), artist: t.Optional(MBID) }) },
        async ({ body, request, status: respond }: any) => {
          const user = await auth.userFrom(request)
          if (!user || !auth.can(user, 'musicbrainz.import')) return respond(403, { error: 'You need the musicbrainz.import permission' })
          if (!body.release && !body.artist) return respond(400, { error: 'Send { release } or { artist }: a MusicBrainz id' })
          if (status.importing) return respond(409, { error: `Already importing ${status.importing}` })
          const what = body.release ? `release ${body.release}` : `artist ${body.artist}`
          status.importing = what
          // Artists take a while at one request a second: answer now, import in the background.
          const job = (body.release ? importRelease(body.release) : importArtist(body.artist))
            .then((count: number) => Plugin.log(`Imported ${count} songs from ${what}`))
            .catch((error: Error) => {
              status.lastError = error.message
              Plugin.error(`Importing ${what} failed: ${error.message}`)
            })
            .finally(() => {
              status.importing = null
            })
          if (body.release) await job
          return { importing: what, done: Boolean(body.release) }
        },
      ),
  )

  Plugin.subscribe('lifecycle::disable', () => {
    Plugin.unsubscribe('hook::onSubsonic::before', onSearch)
    Plugin.removeAll()
  })

  Plugin.log(`Indexing from MusicBrainz as "${userAgent}"${indexSearches ? ', on search' : ''}`)
}
