import { isBoolean, oneOf, persisted } from './storage'

export type AudioQuality = 'auto' | 'high' | 'low'
export type RepeatMode = 'off' | 'all' | 'one'

export const hapticsEnabled = persisted('noctis:haptics', true, isBoolean)

/* Playback */
export const audioQuality = persisted<AudioQuality>('noctis:quality', 'auto', oneOf('auto', 'high', 'low'))
export const repeatMode = persisted<RepeatMode>('noctis:repeat-mode', 'off', oneOf('off', 'all', 'one'))
export const shuffleEnabled = persisted('noctis:shuffle', false, isBoolean)
/**
 * How far into a song "Previous" restarts it instead of going back a song: "off" always goes
 * back, a number of seconds, or "full" (restarts from anywhere past the first second).
 */
export type PreviousRestart = 'off' | '3' | '5' | '10' | 'full'
export const previousRestart = persisted<PreviousRestart>('noctis:previous-restart', '3', oneOf('off', '3', '5', '10', 'full'))
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
/** Songs downloaded at once (a service can allow fewer, see ServiceDefinition.downloads). */
export const downloadConcurrency = persisted('noctis:download-concurrency', 2, (value) => typeof value === 'number' && value >= 1)
/** A system notification with the download progress while the app is in the background. */
export const downloadNotifications = persisted('noctis:download-notifications', true, isBoolean)

/* Content */
export const contentLanguage = persisted('noctis:hl', 'en', (value) => typeof value === 'string')
export const contentCountry = persisted('noctis:gl', 'US', (value) => typeof value === 'string')

/** Desktop: closing the window keeps Noctis running in the system tray. */
export const minimizeToTray = persisted('noctis:minimize-to-tray', false, isBoolean)

/* Appearance */
/** "full" keeps the app's animations even when the system asks for none (see main.css). */
export const motion = persisted<'system' | 'full'>('noctis:motion', 'system', oneOf('system', 'full'))
export const playerArtworkColors = persisted('noctis:player-art-colors', true, isBoolean)
export const pureBlack = persisted('noctis:pure-black', false, isBoolean)
