import { Noctis, type Song } from './host'
import { looksLike, romanizers, translators } from './translate'
import { localKey, localSource, readLocalFile, type LocalLyrics } from './sources/local'
import { genius } from './sources/genius'
import { lrclib } from './sources/lrclib'
import { betterlyrics } from './sources/betterlyrics'
import { kugou } from './sources/kugou'
import { musixmatch } from './sources/musixmatch'
import { unison } from './sources/unison'
import { youlyplus } from './sources/youlyplus'
import { netease } from './sources/netease'
import { qq } from './sources/qq'
import { scriptOf } from './romanize'
import { romanizations, settings, sources, translations, view } from './state'
import type { Lyrics, Query } from './types'
import { kv, messageOf } from './util'

const { watch } = Noctis.packages.vue
const { player, i18n } = Noctis.libs

export const songKeyOf = (song: Song) => `${song.source ?? 'youtube-music'}:${song.id}`

export function queryFor(song: Song): Query {
  return {
    song,
    title: song.title,
    artists: song.artists.map((artist) => artist.name),
    album: song.album?.name,
    duration: song.duration || (player.duration.value > 0 ? player.duration.value : undefined),
  }
}

for (const source of [localSource((query) => songKeyOf(query.song)), youlyplus, betterlyrics, musixmatch, netease, qq, kugou, lrclib, unison, genius]) sources.set(source.id, source)

/** Sources that will be asked, best-trusted first. */
function activeSources() {
  const order = [...settings.sourceOrder, ...[...sources.keys()].filter((id) => !settings.sourceOrder.includes(id))]
  return order.filter((id) => sources.has(id) && !settings.sourcesOff.includes(id)).map((id) => sources.get(id)!)
}

const SYNC_RANK = { word: 2, line: 1, none: 0 } as const

function rank(lyrics: Lyrics, index: number): number {
  if (lyrics.instrumental) return -1000 + (settings.preferSynced ? 0 : -index)
  return (settings.preferSynced ? SYNC_RANK[lyrics.sync] * 100 : 0) - index
}

function indexOfSource(id: string): number {
  const order = [...settings.sourceOrder, ...[...sources.keys()].filter((key) => !settings.sourceOrder.includes(key))]
  const at = order.indexOf(id)
  return at === -1 ? order.length : at
}

/* ------------------------------------------------------------------ *
 * Finding lyrics for the current song
 * ------------------------------------------------------------------ */

let generation = 0
const misses = new Map<string, number>()
const MISS_MS = 5 * 60_000

function pickBest(candidates: Lyrics[], chosen: string): Lyrics | null {
  if (candidates.length === 0) return null
  const picked = chosen && candidates.find((item) => item.source === chosen)
  if (picked) return picked
  return [...candidates].sort((a, b) => rank(b, indexOfSource(b.source)) - rank(a, indexOfSource(a.source)))[0]
}

function show(candidates: Lyrics[]) {
  view.candidates = candidates
  const best = pickBest(candidates, view.chosen)
  view.lyrics = best
  view.status = best ? 'ready' : view.pending.length ? 'loading' : 'none'
}

export async function load(song: Song | null, refresh = false) {
  const run = ++generation
  if (!song) {
    resetView('')
    return
  }
  const key = songKeyOf(song)
  resetView(key)
  view.status = 'loading'

  view.offset = (await kv.get<number>(`offset:${key}`)) ?? 0
  view.chosen = (await kv.get<string>(`choice:${key}`)) ?? ''
  if (run !== generation) return

  if (!refresh) {
    const cached = await kv.get<Lyrics[]>(`lyrics:${key}`)
    if (run !== generation) return
    if (cached?.length) {
      show(cached)
      void enrich(run)
      return
    }
    const missed = misses.get(key)
    if (missed && Date.now() - missed < MISS_MS) {
      view.status = 'none'
      return
    }
  }

  const query = queryFor(song)
  const list = activeSources()
  const found: Lyrics[] = []
  view.pending = list.map((source) => source.id)

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    if (list.length === 0) finish()
    const timeout = setTimeout(finish, settings.sourceTimeout * 1000)

    list.forEach((source) => {
      source
        .get(query)
        .then((lyrics) => {
          if (lyrics && (lyrics.lines.length || lyrics.instrumental)) found.push(lyrics)
        })
        .catch((error) => {
          if (run === generation) view.failures[source.id] = messageOf(error)
        })
        .finally(() => {
          if (run !== generation) return finish()
          view.pending = view.pending.filter((id) => id !== source.id)
          show([...found])
          // Stop waiting once nothing still pending could beat what we have.
          const best = pickBest(found, view.chosen)
          const top = best ? rank(best, indexOfSource(best.source)) : -Infinity
          const ceiling = (id: string) => (settings.preferSynced ? 200 : 0) - indexOfSource(id)
          if (view.pending.length === 0 || (best && !view.chosen && view.pending.every((id) => ceiling(id) <= top))) {
            clearTimeout(timeout)
            finish()
          }
        })
    })
  })
  if (run !== generation) return

  view.pending = []
  show([...found])
  if (found.length) {
    void kv.set(`lyrics:${key}`, JSON.parse(JSON.stringify(found)))
    void kv.trim(settings.cacheSize * 3)
    void enrich(run)
  } else {
    misses.set(key, Date.now())
  }
}

function resetView(key: string) {
  view.songKey = key
  view.status = 'idle'
  view.error = ''
  view.pending = []
  view.failures = {}
  view.lyrics = null
  view.candidates = []
  view.chosen = ''
  view.offset = 0
  view.translation = 'off'
  view.romanization = 'off'
  view.translationError = ''
  view.romanizationError = ''
  view.showCover = false
  translations.value = []
  romanizations.value = []
}

/** Pick which source's lyrics to show for this song, and remember it. */
export function choose(source: string) {
  view.chosen = source
  void kv.set(`choice:${view.songKey}`, source)
  show(view.candidates)
  void enrich(generation)
}

export function setOffset(ms: number) {
  view.offset = Math.max(-10_000, Math.min(10_000, Math.round(ms)))
  void kv.set(`offset:${view.songKey}`, view.offset)
}

export async function attachFile(song: Song, name: string, text: string) {
  const stored: LocalLyrics = readLocalFile(name, text, song.duration)
  await kv.set(localKey(songKeyOf(song)), stored)
  await kv.remove(`lyrics:${songKeyOf(song)}`)
  view.chosen = 'local'
  await kv.set(`choice:${songKeyOf(song)}`, 'local')
  await load(song, true)
}

export async function detachFile(song: Song) {
  await kv.remove(localKey(songKeyOf(song)))
  await kv.remove(`lyrics:${songKeyOf(song)}`)
  await kv.remove(`choice:${songKeyOf(song)}`)
  await load(song, true)
}

export async function clearCache() {
  await kv.clearCache()
  misses.clear()
}

/* ------------------------------------------------------------------ *
 * Translations and romanization
 * ------------------------------------------------------------------ */

export function targetLanguage(): string {
  const wanted = settings.translateTarget === 'app' ? i18n.language.value : settings.translateTarget
  return wanted.toLowerCase().split('-')[0]
}

const realLines = (lyrics: Lyrics) => lyrics.lines.map((line, index) => ({ line, index })).filter(({ line }) => !line.interlude && line.text.trim())

async function translate(lyrics: Lyrics, run: number) {
  const target = targetLanguage()
  const lines = realLines(lyrics)
  const out: (string | null)[] = lyrics.lines.map(() => null)

  const shipped = lyrics.translationLang === target && ['auto', 'source'].includes(settings.translateProvider)
  if (shipped) {
    for (const { line, index } of lines) out[index] = line.translation ?? null
    if (lines.some(({ line }) => line.translation)) {
      translations.value = out
      view.translation = 'done'
      return
    }
  }
  if (settings.translateProvider === 'source') {
    view.translation = 'error'
    view.translationError = `${lyrics.sourceName} has no ${target} translation of this song`
    return
  }

  const need = lines.filter(({ line }) => !settings.skipOwnLanguage || !looksLike(line.text, target))
  if (need.length === 0) {
    translations.value = out
    view.translation = 'done'
    return
  }

  const chain =
    settings.translateProvider === 'auto'
      ? ['deepl', 'ai', 'google'].filter((id) => translators.get(id) && !translators.get(id)!.unavailable())
      : [settings.translateProvider]
  const key = `translation:${view.songKey}:${lyrics.source}:${target}:${chain[0]}`
  const cached = await kv.get<(string | null)[]>(key)
  if (run !== generation) return
  if (cached && cached.length === out.length) {
    translations.value = cached
    view.translation = 'done'
    return
  }

  view.translation = 'working'
  let lastError = ''
  for (const id of chain) {
    const provider = translators.get(id)
    const blocked = provider?.unavailable()
    if (!provider || blocked) {
      lastError = blocked ?? `Unknown translator "${id}"`
      continue
    }
    try {
      const result = await provider.translate(need.map(({ line }) => line.text), target, { title: view.lyrics?.lines.length ? queryTitle() : '', artists: queryArtists() })
      if (run !== generation) return
      need.forEach(({ index }, at) => {
        const text = (result[at] ?? '').trim()
        out[index] = text && text !== lyrics.lines[index].text ? text : null
      })
      translations.value = out
      view.translation = 'done'
      void kv.set(key, out)
      return
    } catch (error) {
      lastError = `${provider.name}: ${messageOf(error)}`
    }
  }
  if (run !== generation) return
  view.translation = 'error'
  view.translationError = lastError || 'No translator is set up'
}

const queryTitle = () => player.currentSong.value?.title ?? ''
const queryArtists = () => player.currentSong.value?.artists.map((artist) => artist.name) ?? []

async function romanize(lyrics: Lyrics, run: number) {
  const lines = realLines(lyrics)
  const out: (string | null)[] = lyrics.lines.map(() => null)
  const todo: { index: number; text: string }[] = []
  const japanese = lyrics.lines.some((line) => scriptOf(line.text) === 'ja')

  for (const { line, index } of lines) {
    if (scriptOf(line.text) === 'latin' || scriptOf(line.text) === 'other') continue
    if (line.romanization) out[index] = line.romanization
    else todo.push({ index, text: line.text })
  }
  if (todo.length === 0) {
    romanizations.value = out
    view.romanization = 'done'
    return
  }

  const key = `romanization:${view.songKey}:${lyrics.source}:${settings.romanizer}`
  const cached = await kv.get<(string | null)[]>(key)
  if (run !== generation) return
  if (cached && cached.length === out.length) {
    romanizations.value = cached
    view.romanization = 'done'
    return
  }

  view.romanization = 'working'
  let left = todo
  let lastError = ''
  const chain = settings.romanizer === 'auto' ? ['builtin', 'ai'] : settings.romanizer === 'builtin' ? ['builtin'] : [settings.romanizer]
  for (const id of chain) {
    if (left.length === 0) break
    const provider = romanizers.get(id)
    const blocked = provider?.unavailable()
    if (!provider || blocked) {
      // Auto only uses the AI when it is set up; a named choice reports why it can't run.
      if (settings.romanizer !== 'auto') lastError = blocked ?? `Unknown romanizer "${id}"`
      continue
    }
    try {
      const result = await provider.romanize(left.map((item) => item.text), { title: queryTitle(), artists: queryArtists(), japanese })
      if (run !== generation) return
      const rest: typeof left = []
      left.forEach((item, at) => {
        const text = result[at]?.trim()
        if (text) out[item.index] = text
        else rest.push(item)
      })
      left = rest
    } catch (error) {
      lastError = `${provider.name}: ${messageOf(error)}`
    }
  }
  if (run !== generation) return
  // Kanji nobody could read: say what would help rather than leave the line bare.
  if (left.length > 0 && !lastError) lastError = 'Some kanji lines need a source with romaji or an AI romanizer (Settings → Lyrics)'
  romanizations.value = out
  view.romanization = lastError && out.every((item) => item === null) ? 'error' : 'done'
  view.romanizationError = lastError
  void kv.set(key, out)
}

export async function enrich(run = generation) {
  const lyrics = view.lyrics
  if (!lyrics || lyrics.instrumental) return
  translations.value = []
  romanizations.value = []
  view.translation = 'off'
  view.romanization = 'off'
  const jobs: Promise<void>[] = []
  if (settings.translate) jobs.push(translate(lyrics, run))
  if (settings.romanize) jobs.push(romanize(lyrics, run))
  await Promise.all(jobs)
}

/* ------------------------------------------------------------------ *
 * Following the player
 * ------------------------------------------------------------------ */

export function startFollowing(): () => void {
  const stops = [
    watch(
      () => player.currentSong.value,
      (song, previous) => {
        if (!settings.enabled) return
        if (song && previous && songKeyOf(song) === songKeyOf(previous)) return
        void load(song)
      },
      { immediate: true },
    ),
    // Settings that change what is fetched or derived.
    watch(
      () => [settings.translate, settings.translateTarget, settings.translateProvider, settings.skipOwnLanguage, i18n.language.value],
      () => void enrich(),
    ),
    watch(
      () => [settings.romanize, settings.romanizer],
      () => void enrich(),
    ),
    watch(
      () => [settings.enabled, settings.sourceOrder.join(), settings.sourcesOff.join(), settings.preferSynced],
      () => {
        misses.clear()
        void load(settings.enabled ? player.currentSong.value : null)
      },
    ),
  ]
  return () => stops.forEach((stop) => stop())
}
