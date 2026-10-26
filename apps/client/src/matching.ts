import { itemKey, sourceOf, type Song } from './models'
import { registerPlaybackOptions, type PlaybackOption } from './playFrom'
import { request } from './services/api'
import { services } from './services/registry'
import { readJson, writeJson } from './storage'

/**
 * Finding a song on another service by searching it: what lets a song known only from
 * metadata (a MusicBrainz entry on a server, a Spotify track) play from YouTube Music,
 * SoundCloud or any service with search and streams.
 *
 * A service plugin offers itself with one call:
 *
 *   const stop = Noctis.libs.matching.offerAsSource('soundcloud')
 *
 * and every song from elsewhere gets a "Play from" option on it, found when it's first
 * needed, remembered, and dropped when the song already has that service as a source.
 */

function normalize(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((feat|ft|with)\.?[^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s-\s.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|radio)\b.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function overlap(a: string, b: string): number {
  const left = new Set(normalize(a).split(' ').filter(Boolean))
  const right = new Set(normalize(b).split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / Math.max(left.size, right.size)
}

/** Uploads that change the song: never a stand-in, unless that's what was asked for. */
const ALTERED = /\b(bass ?boost(ed)?|slowed|reverb|sped ?up|speed ?up|nightcore|8d|cover|karaoke|instrumental|acapella|a cappella|1 ?h(ou)?r|10 ?h(ou)?rs?|loop(ed)?|mashup|tutorial|lesson|reaction|remix|edit|bootleg|live)\b/

/**
 * 0..1: how likely `candidate` is the same recording as `wanted`, from the title, the
 * artists and the length. Uploads often put the artist in the title ("Artist - Song"),
 * so the candidate's title counts towards the artist too.
 */
export function matchScore(wanted: Song, candidate: Song): number {
  const altered = ALTERED.exec(`${candidate.title.toLowerCase()}`)?.[0]
  if (altered && !wanted.title.toLowerCase().includes(altered)) return 0
  const candidateArtists = normalize(candidate.artists.map((artist) => artist.name).join(' '))
  const titleWithoutArtist = wanted.artists.reduce((title, artist) => title.replace(normalize(artist.name), ' '), normalize(candidate.title))
  const title = Math.max(overlap(wanted.title, candidate.title), overlap(wanted.title, titleWithoutArtist))
  const names = wanted.artists.map((artist) => normalize(artist.name)).filter(Boolean)
  const haystack = `${candidateArtists} ${normalize(candidate.title)}`
  const artist = names.some((name) => haystack.includes(name)) ? 1 : overlap(names.join(' '), candidateArtists)
  const difference = wanted.duration && candidate.duration ? Math.abs(wanted.duration - candidate.duration) : 30
  // Both lengths known and far apart: an hour-long loop, a medley, an excerpt. Never the song.
  if (wanted.duration && candidate.duration && difference > Math.max(20, wanted.duration * 0.15)) return 0
  const duration = Math.max(0, 1 - difference / 20)
  return title * 0.45 + artist * 0.3 + duration * 0.25 - (candidate.isVideo ? 0.05 : 0)
}

/** Songs on `service` that could be `song`, best first, with their scores. */
export async function candidatesOn(service: string, song: Song, accept: (candidate: Song) => boolean = () => true): Promise<{ song: Song; score: number }[]> {
  const search = services[service]?.search
  if (!search) return []
  const query = `${song.artists[0]?.name ?? ''} ${song.title}`.trim()
  // A "songs" filter if the service has one; otherwise the sections of "all".
  const filter = search.filters?.find((item) => /^songs?$|^tracks?$/.test(item.id))?.id
  const result = await request(service, 'search.query', { query, type: filter ?? 'all' })
  const items = filter ? result.items : result.sections.flatMap((section) => section.items)
  return items
    .filter((item): item is Song => item.type === 'song' && accept(item))
    .map((candidate) => ({ song: candidate, score: matchScore(song, candidate) }))
    .sort((a, b) => b.score - a.score)
}

const MAX_REMEMBERED = 2000
const RETRY_MISSES = 7 * 24 * 3600_000

/**
 * Offer `service` as a source for songs from other services, as a "Play from" option
 * (target "own:<service>"). `skip`: sources not to match (they have their own way);
 * `accept`: which of the service's songs may stand in for another (not a 30-second preview…).
 */
export function offerAsSource(service: string, options: { minScore?: number; skip?: string[]; accept?: (candidate: Song) => boolean } = {}): () => void {
  const minScore = options.minScore ?? 0.6
  const skip = new Set([service, ...(options.skip ?? [])])
  const storageKey = `noctis:matches:${service}`
  /** Song key → its match, or { missing: time } when the search found nothing good. */
  const remembered = readJson<Record<string, Song | { missing: number }>>(storageKey, {})
  const pending = new Map<string, Promise<Song | null>>()
  let saveTimer = 0

  function remember(key: string, value: Song | { missing: number }) {
    delete remembered[key]
    remembered[key] = value
    const keys = Object.keys(remembered)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete remembered[old]
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => writeJson(storageKey, remembered), 500)
  }

  function matchFor(song: Song): Promise<Song | null> {
    const key = `${sourceOf(song)}|${itemKey(song)}`
    const known = remembered[key]
    if (known && 'missing' in known) {
      if (Date.now() - known.missing < RETRY_MISSES) return Promise.resolve(null)
    } else if (known) {
      return Promise.resolve(known)
    }
    const running = pending.get(key)
    if (running) return running
    const task = candidatesOn(service, song, options.accept)
      .then((ranked) => {
        const best = ranked[0]
        if (!best || best.score < minScore) {
          remember(key, { missing: Date.now() })
          return null
        }
        remember(key, best.song)
        return best.song
      })
      .finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  }

  return registerPlaybackOptions(async (song): Promise<PlaybackOption[]> => {
    const definition = services[service]
    if (skip.has(sourceOf(song)) || !definition?.streams || !definition.search) return []
    const match = await matchFor(song).catch(() => null)
    if (!match) return []
    const minutes = match.duration ? ` · ${Math.floor(match.duration / 60)}:${String(Math.round(match.duration % 60)).padStart(2, '0')}` : ''
    return [
      {
        id: `match:${service}:${match.id}`,
        label: definition.name,
        description: `Found by searching: ${match.title} – ${match.artists.map((artist) => artist.name).join(', ')}${minutes}`,
        available: true,
        target: `own:${service}`,
        group: 'own',
        fallback: true,
        resolve: (efficient) => request(service, 'streams.resolve', { song: match, efficient }),
      },
    ]
  })
}
