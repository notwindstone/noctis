import type { Ref } from 'vue'
import { Noctis } from './host'
import { DEFAULTS, type Settings } from './settings'
import type { Lyrics, LyricsSource } from './types'

const { reactive, ref, shallowRef, watch } = Noctis.packages.vue

/** The user's settings (see settings.ts). Loaded from the plugin's storage by `initState`. */
export const settings = reactive<Settings>({ ...DEFAULTS, sourceOrder: [...DEFAULTS.sourceOrder], sourcesOff: [] })

export type Status = 'idle' | 'loading' | 'ready' | 'none' | 'error'
export type Work = 'off' | 'working' | 'done' | 'error'

/** What the player is showing right now. */
export const view = reactive({
  songKey: '',
  status: 'idle' as Status,
  error: '',
  /** Sources still being asked. */
  pending: [] as string[],
  /** Why each source that failed did. */
  failures: {} as Record<string, string>,
  lyrics: null as Lyrics | null,
  candidates: [] as Lyrics[],
  /** The source the user picked for this song, if any. */
  chosen: '',
  /** Per-song timing correction, milliseconds (positive: lyrics later). */
  offset: 0,
  translation: 'off' as Work,
  translationError: '',
  romanization: 'off' as Work,
  romanizationError: '',
  fullscreen: false,
  /** Showing the cover instead of lyrics, for this song only. */
  showCover: false,
})

/** Translations and romanizations by line index (null where a line needs none). */
export const translations: Ref<(string | null)[]> = shallowRef([])
export const romanizations: Ref<(string | null)[]> = shallowRef([])

/** Sources by id, in no particular order (settings.sourceOrder says the order). */
export const sources = new Map<string, LyricsSource>()

export const tick = ref(0)

let storage: { get<T>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void } | null = null

export function initState(plugin: { storage: NonNullable<typeof storage> }): () => void {
  storage = plugin.storage
  const saved = storage.get<Partial<Settings>>('settings', {}) ?? {}
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key in saved && typeof saved[key] === typeof DEFAULTS[key]) (settings as Record<string, unknown>)[key] = saved[key]
  }
  // New sources added by an update join the end of a saved order.
  for (const id of DEFAULTS.sourceOrder) if (!settings.sourceOrder.includes(id)) settings.sourceOrder.push(id)
  return watch(settings, () => storage?.set('settings', { ...settings }), { deep: true })
}
