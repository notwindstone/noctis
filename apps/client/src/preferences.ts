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
 * back, a number of seconds (any positive number, typed in Settings), or "full" (restarts from
 * anywhere past the first second).
 */
export type PreviousRestart = string
export const previousRestart = persisted<PreviousRestart>(
  'noctis:previous-restart',
  '3',
  (value) => value === 'off' || value === 'full' || (typeof value === 'string' && Number(value) > 0),
)
/** A song that can't play is skipped, and the next one plays. Off: playback stops there with the error. */
export const skipFailed = persisted('noctis:skip-failed', true, isBoolean)
/** Songs that autoplay and radios add are left out when shorter than this many seconds (0 = keep them). */
export const autoSkipShorter = persisted('noctis:autoskip-shorter', 0, (value) => typeof value === 'number' && value >= 0)
/** ...or longer than this many seconds: mixes, station recordings, hour-long uploads (0 = keep them). */
export const autoSkipLonger = persisted('noctis:autoskip-longer', 0, (value) => typeof value === 'number' && value >= 0)
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
/** Desktop: downloads and cache are ordinary files named after the song, not the webview's hidden cache. */
export const saveAsFiles = persisted('noctis:save-as-files', true, isBoolean)
/** Songs longer than this many minutes aren't downloaded (mixes, hour-long uploads); 0 = no limit. Stations never are. */
export const downloadMaxMinutes = persisted('noctis:download-max-minutes', 180, (value) => typeof value === 'number' && value >= 0)
/** Songs downloaded at once (a service can allow fewer, see ServiceDefinition.downloads). */
export const downloadConcurrency = persisted('noctis:download-concurrency', 1, (value) => typeof value === 'number' && value >= 1)
/**
 * What happens to a song when it's liked: nothing, it's put in the cache (trimmed with the rest of it),
 * or it's downloaded and kept. Choosing "download" also queues the songs already liked.
 */
export type SaveLiked = 'off' | 'cache' | 'download'
export const saveLiked = persisted<SaveLiked>('noctis:save-liked', 'off', oneOf('off', 'cache', 'download'))
/** A system notification with the download progress while the app is in the background. */
export const downloadNotifications = persisted('noctis:download-notifications', true, isBoolean)

/* Content */
export const contentLanguage = persisted('noctis:hl', 'en', (value) => typeof value === 'string')
export const contentCountry = persisted('noctis:gl', 'US', (value) => typeof value === 'string')

/** Desktop: closing the window keeps Noctis running in the system tray. */
export const minimizeToTray = persisted('noctis:minimize-to-tray', false, isBoolean)

/* Appearance */
/** "full" keeps the app's animations even when the system asks for none, "never" drops them (see main.css). */
export const motion = persisted<'system' | 'full' | 'never'>('noctis:motion', 'system', oneOf('system', 'full', 'never'))
/** Whether screen transitions should be skipped: the user said never, or the system asks for none and they didn't override it. */
export const animationsOff = () =>
  motion.value === 'never' || (motion.value === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
/** The playing-song bars follow the music (needs audio analysis) instead of a canned animation. */
export const liveBars = persisted('noctis:live-bars', false, isBoolean)
/** Playlist and album pages: songs as rows or as cover cards (a grid), for every page. */
export type SongLayout = 'list' | 'grid'
export type GridSize = 'small' | 'medium' | 'large'
export const songLayout = persisted<SongLayout>('noctis:song-layout', 'list', oneOf('list', 'grid'))
export const gridSize = persisted<GridSize>('noctis:grid-size', 'medium', oneOf('small', 'medium', 'large'))
/** Grid cards: the artist and length under the title. */
export const gridDetails = persisted('noctis:grid-details', true, isBoolean)
/** Grid cards: the track number over the cover, on numbered lists (albums). */
export const gridNumbers = persisted('noctis:grid-numbers', true, isBoolean)
/** Gray line under the artist in the player: codec, bitrate, sampling rate and size of the stream. */
export const showStreamInfo = persisted('noctis:show-stream-info', false, isBoolean)
export const playerArtworkColors = persisted('noctis:player-art-colors', true, isBoolean)
export const pureBlack = persisted('noctis:pure-black', false, isBoolean)
