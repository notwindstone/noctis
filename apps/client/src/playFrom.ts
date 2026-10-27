import { computed } from 'vue'
import { findLocalMatch, localTrackUrl, localTracks } from './local/library'
import { DEVICE_SERVICE } from './local/service'
import { itemKey, sourceOf, type Song, type StreamInfo } from './models'
import { request } from './services/api'
import { services } from './services/registry'
import { persisted } from './storage'

/**
 * "Play from": where a song's audio comes from.
 *
 * A song can usually be played several ways: from the service it came from, from a
 * Noctis server's stream of any of its sources, from your own account on another
 * service, or from a file on this device. Option providers list them for a song (the
 * server, the device library and plugins each add theirs).
 *
 * Every option belongs to a target, which is the same for every song: "device",
 * "server:<provider>" (the server's copy from one provider, e.g. YouTube Music),
 * "own:<service>" (your own account on a service). The preference for all songs is a
 * mode, or one target:
 * - "auto": a copy on this device first, then your own services where the server says
 *   one can play the song, then the server;
 * - "server": the server's stream (or the song's own service);
 * - "own": like auto, and the server only as a last resort;
 * - a target: that one whenever the song has it, otherwise like "auto".
 *
 * A choice for one song (the player's Play from, "This song") beats the preference.
 * The same dialog shows both (src/components/PlayFromDialog.vue).
 */

export type PlaybackMode = 'auto' | 'server' | 'own'
/** A mode, or a target id ("server:youtube-music", "own:spotify", "device"). */
export type PlaybackPreference = PlaybackMode | (string & {})

export const PLAYBACK_MODES: Record<PlaybackMode, { label: string; description: string }> = {
  auto: { label: 'Automatic', description: 'A copy on this device, then your own services, then the server' },
  server: { label: 'Where it comes from', description: "The server's stream, or the song's own service" },
  own: { label: 'Yours first', description: 'Your files and services; servers only as a fallback' },
}

const isMode = (value: string): value is PlaybackMode => Object.hasOwn(PLAYBACK_MODES, value)

export const playbackPreference = persisted<PlaybackPreference>('noctis:playback-source', 'auto', (value) => typeof value === 'string' && value.length > 0)

/** The preference as a mode: a specific target falls back to "auto" for songs without it. */
export const playbackMode = computed<PlaybackMode>(() => (isMode(playbackPreference.value) ? playbackPreference.value : 'auto'))

/** Where an option plays from: a server's stream, or something of yours (this device, your accounts). */
export type PlaybackGroup = 'server' | 'own'

export interface PlaybackOption {
  /** Stable for the song: "default", "device", "server:<source>", "own:<service>:<id>"… */
  id: string
  label: string
  /** Quality, or why it isn't available. */
  description?: string
  available: boolean
  /** The target it belongs to ("server:youtube-music", "own:spotify", "device"); options without one only show for their song. */
  target?: string
  /** Default "own". */
  group?: PlaybackGroup
  /**
   * Found by searching another service (src/matching.ts): only offered when the song
   * has nothing better for the same target, e.g. the server's own YouTube Music source.
   */
  fallback?: boolean
  /** Unavailable because a client plugin is missing: which, and where the server offers it. */
  install?: { plugin: string; download: string | null }
  resolve(efficient: boolean): Promise<StreamInfo>
}

/** A target as the preference sees it: the same for every song. */
export interface PlaybackTarget {
  id: string
  label: string
  description?: string
  group: PlaybackGroup
  /** False: shown greyed out, with `description` saying why (a missing plugin, no music folders…). */
  available: boolean
}

export type PlaybackOptionProvider = (song: Song) => Promise<PlaybackOption[]>
/** Read on every render: return the current list (it may read reactive state). */
export type PlaybackTargetProvider = () => PlaybackTarget[]

const providers = new Set<PlaybackOptionProvider>()
const targetProviders = new Set<PlaybackTargetProvider>()

/** Add options for songs (plugins can call this through Noctis.libs.playFrom). */
export function registerPlaybackOptions(provider: PlaybackOptionProvider) {
  providers.add(provider)
  return () => providers.delete(provider)
}

/** Add targets the preference can name (a plugin's own service is listed without this). */
export function registerPlaybackTargets(provider: PlaybackTargetProvider) {
  targetProviders.add(provider)
  return () => targetProviders.delete(provider)
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

const SERVER_SERVICE = 'noctis-server'

/** The targets every song might have: this device, your services, and what providers add (the server's). */
export function playbackTargets(): PlaybackTarget[] {
  const targets: PlaybackTarget[] = [
    {
      id: 'device',
      label: 'On this device',
      group: 'own',
      available: localTracks.value.length > 0,
      description: localTracks.value.length > 0 ? 'The same song in your music folders' : 'No music folders yet (Settings → On this device)',
    },
  ]
  for (const [id, service] of Object.entries(services)) {
    if (id === DEVICE_SERVICE || id === SERVER_SERVICE || !service.streams) continue
    targets.push({ id: `own:${id}`, label: service.name, group: 'own', available: true, description: 'With your own account' })
  }
  const seen = new Set(targets.map((target) => target.id))
  for (const provider of targetProviders) {
    let list: PlaybackTarget[] = []
    try {
      list = provider()
    } catch {
      /* a broken provider shouldn't hide the rest */
    }
    for (const target of list) {
      if (seen.has(target.id)) continue
      seen.add(target.id)
      targets.push(target)
    }
  }
  return targets
}

/** "Automatic", "Server · YouTube Music"… for any preference value. */
export function preferenceLabel(value: PlaybackPreference = playbackPreference.value): string {
  if (isMode(value)) return PLAYBACK_MODES[value].label
  return playbackTargets().find((target) => target.id === value)?.label ?? `${value} (not available)`
}

/* ------------------------------------------------------------------ *
 * Choices for one song
 * ------------------------------------------------------------------ */

const MAX_CHOICES = 500

/** Choices made in the player's Play from: song key → option id. Kept across restarts. */
const choices = persisted<Record<string, string>>('noctis:play-from-choices', {}, (value) => typeof value === 'object' && value !== null && !Array.isArray(value))

export function chosenOption(song: Song): string | null {
  return choices.value[itemKey(song)] ?? null
}

/** `null` forgets the choice: the song follows the preference again. */
export function chooseOption(song: Song, id: string | null) {
  const next = { ...choices.value }
  delete next[itemKey(song)]
  if (id !== null) next[itemKey(song)] = id
  // Oldest first (insertion order): drop the oldest past the limit.
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CHOICES))) delete next[key]
  choices.value = next
}

/* ------------------------------------------------------------------ *
 * Options for one song
 * ------------------------------------------------------------------ */

/** The song's own service, the way it'd play without "Play from". */
function defaultOption(song: Song): PlaybackOption {
  const service = sourceOf(song)
  const fromServer = service === SERVER_SERVICE
  return {
    id: 'default',
    label: fromServer ? `${services[service]?.name ?? 'Server'} · Its best source` : (services[service]?.name ?? service),
    description: fromServer ? 'The server picks' : 'Where this song comes from',
    available: Boolean(services[service]?.streams),
    target: fromServer ? undefined : service === DEVICE_SERVICE ? 'device' : `own:${service}`,
    group: fromServer ? 'server' : 'own',
    resolve: (efficient) => request(service, 'streams.resolve', { song, efficient }),
  }
}

/** The same song in a music folder on this device. */
export function deviceOption(song: Song): PlaybackOption | null {
  if (sourceOf(song) === DEVICE_SERVICE) return null
  const track = findLocalMatch(song.title, song.artists.map((artist) => artist.name))
  if (!track) return null
  return {
    id: 'device',
    label: 'On this device',
    description: [track.mimeType?.replace('audio/', '').toUpperCase(), track.bitrate ? `${track.bitrate} kbps` : '', track.path].filter(Boolean).join(' · '),
    available: true,
    target: 'device',
    group: 'own',
    resolve: async () => ({ url: await localTrackUrl(track), mimeType: track.mimeType ?? 'audio/mpeg', bitrate: (track.bitrate ?? 0) * 1000, contentLength: track.size, expiresAt: Date.now() + 24 * 3600_000 }),
  }
}

/** The song's own option and its copy on this device: what's known without asking providers. */
function baseOptions(song: Song): PlaybackOption[] {
  const options: PlaybackOption[] = [defaultOption(song)]
  const device = deviceOption(song)
  if (device) options.push(device)
  return options
}

/** `base` plus what providers have answered so far, as the song's options. */
function mergeOptions(base: PlaybackOption[], lists: PlaybackOption[][]): PlaybackOption[] {
  const options = [...base]
  const seen = new Set(options.map((option) => option.id))
  // A provider may say more about the default (the server: "no audio here").
  const flat = lists.flat().filter((option) => {
    if (option.id !== 'default') return true
    options[0] = { ...options[0], ...option }
    return false
  })
  const direct = new Set([...options, ...flat].filter((option) => !option.fallback && option.available && option.target).map((option) => option.target))
  for (const option of flat) {
    if (seen.has(option.id) || (option.fallback && option.target && direct.has(option.target))) continue
    seen.add(option.id)
    options.push(option)
  }
  return options
}

/**
 * Every way to play `song`, the default first. `onProgress` is called with the list so
 * far each time a provider answers (a slow one doesn't hold back the rest), and `pending`
 * says how many haven't.
 */
export async function playbackOptions(song: Song, onProgress?: (options: PlaybackOption[], pending: number) => void): Promise<PlaybackOption[]> {
  const base = baseOptions(song)
  const running = [...providers]
  // One slot per provider, so the order doesn't depend on who answers first.
  const answered: PlaybackOption[][] = running.map(() => [])
  let pending = running.length
  onProgress?.(mergeOptions(base, answered), pending)
  await Promise.all(
    running.map(async (provider, index) => {
      answered[index] = await provider(song).catch(() => [])
      pending--
      onProgress?.(mergeOptions(base, answered), pending)
    }),
  )
  return mergeOptions(base, answered)
}

/**
 * When the usual way can't play a song (no audio on the server, a service that refuses
 * it): another available option, this device first, then yours, then a server's.
 */
export async function resolveFallback(song: Song, efficient: boolean, failed: unknown): Promise<StreamInfo> {
  const order = (option: PlaybackOption) => (option.id === 'device' ? 0 : (option.group ?? 'own') === 'own' ? 1 : 2)
  const others = (await playbackOptions(song)).filter((option) => option.available && option.id !== 'default').sort((a, b) => order(a) - order(b))
  for (const option of others) {
    try {
      return await option.resolve(efficient)
    } catch {
      /* the next one */
    }
  }
  throw failed
}

/**
 * The option `id` really is: "default" for a server song with a single server source
 * is that source (the same audio), so it's shown and compared as that source.
 */
export function canonicalOption(options: PlaybackOption[], id: string): string {
  if (id !== 'default' || options.find((option) => option.id === 'default')?.group !== 'server') return id
  const sources = options.filter((option) => option.id.startsWith('server:') && option.available)
  return sources.length === 1 ? sources[0].id : id
}

/**
 * Which of `options` plays the song, as the player would pick it: the song's choice,
 * else the preferred target, else what the mode prefers. Server songs with the "auto"
 * or "own" mode may still end up on one of your services (the server's `streams.resolve`
 * decides); this shows the first that can.
 */
export function pickOption(song: Song, options: PlaybackOption[], preference: PlaybackPreference = playbackPreference.value, chosen = chosenOption(song)): string {
  const available = options.filter((option) => option.available)
  if (chosen && available.some((option) => option.id === chosen)) return chosen
  if (!isMode(preference)) {
    const preferred = available.find((option) => option.target === preference)
    if (preferred) return preferred.id
  }
  const mode = isMode(preference) ? preference : 'auto'
  if (mode !== 'server') {
    if (available.some((option) => option.id === 'device')) return 'device'
    if (sourceOf(song) === SERVER_SERVICE) {
      const own = available.find((option) => option.id.startsWith('own:'))
      if (own) return own.id
    }
  }
  // The usual way can't play it: the fallback plays the first that can (resolveFallback's order).
  if (!available.some((option) => option.id === 'default')) {
    const order = (option: PlaybackOption) => (option.id === 'device' ? 0 : (option.group ?? 'own') === 'own' ? 1 : 2)
    const first = [...available].sort((a, b) => order(a) - order(b))[0]
    if (first) return first.id
  }
  return 'default'
}

/**
 * A stream from the song's chosen option or preferred target, or (without either) from
 * a copy on this device when the mode allows. Null: play it the usual way.
 */
export async function resolveChosen(song: Song, efficient: boolean): Promise<StreamInfo | null> {
  const chosen = chosenOption(song)
  const preference = playbackPreference.value
  if (chosen || !isMode(preference)) {
    const options = await playbackOptions(song)
    if (chosen) {
      // A choice made for this song says why it fails, rather than quietly playing something else.
      const option = options.find((item) => item.id === chosen && item.available)
      if (option) return option.id === 'default' ? null : option.resolve(efficient)
      // The choice is gone (its plugin was removed): follow the preference.
    } else {
      const option = options.find((item) => item.target === preference && item.available)
      if (option?.id === 'default') return null
      if (option) {
        try {
          return await option.resolve(efficient)
        } catch {
          /* a preference falls back to "auto" */
        }
      }
    }
  }
  if (playbackMode.value !== 'server') {
    const device = deviceOption(song)
    if (device) {
      try {
        return await device.resolve(efficient)
      } catch {
        /* fall back to the usual way */
      }
    }
  }
  return null
}
