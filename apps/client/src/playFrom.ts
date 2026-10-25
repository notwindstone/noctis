import { findLocalMatch, localTrackUrl } from './local/library'
import { DEVICE_SERVICE } from './local/service'
import { itemKey, sourceOf, type Song, type StreamInfo } from './models'
import { request } from './services/api'
import { services } from './services/registry'
import { oneOf, persisted } from './storage'

/**
 * "Play from": where a song's audio comes from.
 *
 * A song can usually be played several ways: from the service it came from, from a
 * Noctis server's stream of any of its sources, from your own account on another
 * service, or from a file on this device. Option providers list them for a song (the
 * server, the device library and plugins each add theirs); the player menu shows them,
 * and the choice sticks for that song.
 *
 * Without a choice, the preference in Settings decides:
 * - "auto": a copy on this device first, then your own services where the server says
 *   one can play the song, then the server;
 * - "server": the server's stream (or the song's own service);
 * - "own": like auto, and the server only as a last resort.
 */

export type PlaybackPreference = 'auto' | 'server' | 'own'
export const playbackPreference = persisted<PlaybackPreference>('noctis:playback-source', 'auto', oneOf('auto', 'server', 'own'))

export interface PlaybackOption {
  /** Stable for the song: "default", "device", "server:<source>", "own:<service>:<id>"… */
  id: string
  label: string
  /** Quality, or why it isn't available. */
  description?: string
  available: boolean
  /** Unavailable because a client plugin is missing: which, and where the server offers it. */
  install?: { plugin: string; download: string | null }
  resolve(efficient: boolean): Promise<StreamInfo>
}

export type PlaybackOptionProvider = (song: Song) => Promise<PlaybackOption[]>

const providers = new Set<PlaybackOptionProvider>()

/** Add options for songs (plugins can call this through Noctis.libs.playFrom). */
export function registerPlaybackOptions(provider: PlaybackOptionProvider) {
  providers.add(provider)
  return () => providers.delete(provider)
}

/** Choices made in the player menu: song key → option id. */
const choices = new Map<string, string>()

export function chosenOption(song: Song): string {
  return choices.get(itemKey(song)) ?? 'default'
}

export function chooseOption(song: Song, id: string) {
  if (id === 'default') choices.delete(itemKey(song))
  else choices.set(itemKey(song), id)
}

/** The option that plays (or would play) the song: the choice, or what the preference picks. */
export function effectiveOption(song: Song): string {
  const chosen = chosenOption(song)
  if (chosen !== 'default') return chosen
  return playbackPreference.value !== 'server' && deviceOption(song) ? 'device' : 'default'
}

/** The song's own service, the way it'd play without "Play from". */
function defaultOption(song: Song): PlaybackOption {
  const service = sourceOf(song)
  return {
    id: 'default',
    label: services[service]?.name ?? service,
    description: 'Where this song comes from',
    available: Boolean(services[service]?.streams),
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
    resolve: async () => ({ url: await localTrackUrl(track), mimeType: track.mimeType ?? 'audio/mpeg', bitrate: (track.bitrate ?? 0) * 1000, contentLength: track.size, expiresAt: Date.now() + 24 * 3600_000 }),
  }
}

/** Every way to play `song`, the default first. */
export async function playbackOptions(song: Song): Promise<PlaybackOption[]> {
  const options: PlaybackOption[] = [defaultOption(song)]
  const device = deviceOption(song)
  if (device) options.push(device)
  const lists = await Promise.all([...providers].map((provider) => provider(song).catch(() => [])))
  const seen = new Set(options.map((option) => option.id))
  for (const option of lists.flat()) {
    if (seen.has(option.id)) continue
    seen.add(option.id)
    options.push(option)
  }
  return options
}

/**
 * A stream from the song's chosen option, or (without a choice) from a copy on this
 * device when the preference allows. Null: play it the usual way.
 */
export async function resolveChosen(song: Song, efficient: boolean): Promise<StreamInfo | null> {
  const chosen = chosenOption(song)
  if (chosen !== 'default') {
    const option = (await playbackOptions(song)).find((item) => item.id === chosen && item.available)
    if (option) return option.resolve(efficient)
  }
  if (chosen === 'default' && playbackPreference.value !== 'server') {
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
