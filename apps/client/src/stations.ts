import { isStation, type Song } from './models'
import { persisted } from './storage'

/**
 * Songs found out to be stations while playing (their file reports an impossible length),
 * for the services that don't tell the length up front. Remembered so they're skipped,
 * and left out of downloads, from then on.
 */
const found = persisted<string[]>('noctis:stations', [], (value) => Array.isArray(value))

export const isStationSong = (song: Pick<Song, 'id' | 'duration'>) => isStation(song) || found.value.includes(song.id)

export function markStation(id: string) {
  if (!found.value.includes(id)) found.value = [...found.value, id].slice(-500)
}
