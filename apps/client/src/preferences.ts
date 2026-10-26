import { isBoolean, oneOf, persisted } from './storage'

export type AudioQuality = 'auto' | 'high' | 'low'
export type RepeatMode = 'off' | 'all' | 'one'

export const hapticsEnabled = persisted('noctis:haptics', true, isBoolean)

/* Playback */
export const audioQuality = persisted<AudioQuality>('noctis:quality', 'auto', oneOf('auto', 'high', 'low'))
export const repeatMode = persisted<RepeatMode>('noctis:repeat-mode', 'off', oneOf('off', 'all', 'one'))
export const shuffleEnabled = persisted('noctis:shuffle', false, isBoolean)
export const autoplayRelated = persisted('noctis:autoplay', true, isBoolean)
export const persistentQueue = persisted('noctis:persistent-queue', true, isBoolean)
/** Media notification with lock-screen controls (Android). */
export const mediaControls = persisted('noctis:media-controls', true, isBoolean)
/** Hold a CPU (and Wi-Fi) wake lock while playing, so a sleeping phone doesn't cut the music (Android). */
export const keepAwake = persisted('noctis:keep-awake', true, isBoolean)
export const pauseHistory = persisted('noctis:pause-history', false, isBoolean)

/* Storage */
export const cacheEnabled = persisted('noctis:cache-enabled', true, isBoolean)
/** Maximum size of the automatic song cache, in MB. 0 = unlimited. */
export const maxCacheMb = persisted('noctis:cache-max', 512, (value) => typeof value === 'number' && value >= 0)

/* Content */
export const contentLanguage = persisted('noctis:hl', 'en', (value) => typeof value === 'string')
export const contentCountry = persisted('noctis:gl', 'US', (value) => typeof value === 'string')

/* Appearance */
export const playerArtworkColors = persisted('noctis:player-art-colors', true, isBoolean)
export const pureBlack = persisted('noctis:pure-black', false, isBoolean)
