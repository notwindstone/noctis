import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { version as vueVersion } from 'vue'
import AboutHero from '../components/settings/AboutHero.vue'
import SeedSwatches from '../components/settings/SeedSwatches.vue'
import StorageMeter from '../components/settings/StorageMeter.vue'
import { songCount } from '../format'
import { clearHistory, clearSearchHistory, history, searchHistory } from '../library'
import { navigate } from '../navigation'
import { batch, batchPosition, cached, clearCache, clearDownloads, downloads, formatBytes, usage } from '../offline'
import { preferenceLabel } from '../playFrom'
import { defineSection, group, type SettingsBlock } from '../plugins/rows'
import {
  audioQuality,
  autoplayRelated,
  cacheEnabled,
  downloadConcurrency,
  downloadNotifications,
  saveLiked,
  type SaveLiked,
  contentCountry,
  contentLanguage,
  hapticsEnabled,
  maxCacheMb,
  saveAsFiles,
  downloadMaxMinutes,
  autoSkipLonger,
  autoSkipShorter,
  skipFailed,
  minimizeToTray,
  keepAwake,
  liveBars,
  mediaControls,
  pauseHistory,
  persistentQueue,
  motion,
  playerArtworkColors,
  showStreamInfo,
  previousRestart,
  pureBlack,
  type AudioQuality,
  type PreviousRestart,
} from '../preferences'
import { colorSource, effectiveColorSource, isDark, mode, supportsSystemColor, type ColorSource, type ThemeMode } from '../theme'
import { analysisSupported } from '../analysis'
import { language, languageName, languageOptions, languagePreference, t } from '../i18n'
import { hasNoctisPlugin, isDesktop, platform } from '../native'
import { notify } from '../snackbar'
import { confirm, showPlayFrom } from '../ui'
import { activeService, activeServiceId, services } from '../services/registry'

/**
 * The built-in settings pages, described as data (see src/plugins/rows.ts). Live fields
 * are getters, so each row reads current state when rendered and nothing is rebuilt.
 */

const bool = (state: { value: boolean }) => ({
  get value() {
    return state.value
  },
  set(value: boolean) {
    state.value = value
  },
})

function ask(title: string, message: string, run: () => unknown) {
  confirm({ title, message, confirmLabel: 'Clear', destructive: true, onConfirm: async () => void (await run()) })
}

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

const THEME_LABELS: Record<ThemeMode, string> = { system: 'Follow system', light: 'Light', dark: 'Dark' }
const SOURCE_LABELS: Record<ColorSource, string> = { system: 'Wallpaper', artwork: 'Album art', seed: 'Preset colour' }

const appearanceBlocks: SettingsBlock[] = [
  group('app-language', [
    {
      id: 'app-language',
      icon: 'translate',
      get title() {
        return t('Language')
      },
      description: 'What Noctis itself is written in',
      select: {
        title: 'Language',
        get options() {
          return languageOptions.value
        },
        get value() {
          return languagePreference.value
        },
        set(value) {
          languagePreference.value = value
        },
      },
      get value() {
        return languagePreference.value === 'system' ? `${t('Use system language')} • ${languageName(language.value)}` : undefined
      },
    },
  ]),
  group('tray', [
    {
      id: 'minimize-to-tray',
      icon: 'minimize',
      title: 'Minimize to tray',
      description: 'Closing the window keeps Noctis (and the music) running in the system tray',
      toggle: bool(minimizeToTray),
    },
  ], {
    get hidden() {
      return !isDesktop
    },
  }),
  group('motion', [
    {
      id: 'motion',
      icon: 'animation',
      title: 'Animations',
      description: 'Some systems switch animations off for every app; "Always on" keeps Noctis\'s',
      select: {
        options: [
          { value: 'system', label: 'Follow the system' },
          { value: 'full', label: 'Always on' },
          { value: 'never', label: 'Never', description: 'No slides or fades anywhere' },
        ],
        get value() {
          return motion.value
        },
        set(value) {
          motion.value = value as 'system' | 'full' | 'never'
        },
      },
    },
  ]),
  group('theme', [
    {
      id: 'theme',
      get icon() {
        return mode.value === 'dark' ? 'dark' : mode.value === 'light' ? 'light' : 'auto'
      },
      title: 'Theme',
      select: {
        options: (['system', 'light', 'dark'] as const).map((value) => ({ value, label: THEME_LABELS[value] })),
        get value() {
          return mode.value
        },
        set(value) {
          mode.value = value as ThemeMode
        },
      },
    },
    {
      id: 'pure-black',
      icon: 'contrast',
      title: 'Pure black',
      description: 'True black backgrounds in dark theme',
      toggle: bool(pureBlack),
      get disabled() {
        return !isDark.value
      },
    },
  ]),
  group('dynamic-colour', [
    {
      id: 'source',
      icon: 'wallpaper',
      title: 'Dynamic colour',
      get value() {
        const label = SOURCE_LABELS[colorSource.value]
        return colorSource.value === effectiveColorSource.value ? label : `${label} (unavailable here, using preset)`
      },
      select: {
        get options() {
          return [
            {
              value: 'system',
              label: 'Wallpaper',
              description: supportsSystemColor.value ? 'Material You colours from your wallpaper' : 'Needs Android 12 or later',
            },
            { value: 'artwork', label: 'Album art', description: 'The whole app follows what is playing' },
            { value: 'seed', label: 'Preset colour', description: 'Pick one of the colours below' },
          ]
        },
        get value() {
          return colorSource.value
        },
        set(value) {
          colorSource.value = value as ColorSource
        },
      },
    },
  ]),
  { id: 'swatches', type: 'component', component: SeedSwatches },
  group('player', [
    {
      id: 'player-colours',
      icon: 'image',
      title: 'Player colours from artwork',
      description: 'Tint the player with the colours of the album art',
      toggle: bool(playerArtworkColors),
    },
    {
      id: 'stream-info',
      icon: 'quality',
      title: 'Show audio format',
      description: 'Codec, bitrate, sampling rate and size under the artist in the player',
      toggle: bool(showStreamInfo),
    },
  ]),
]

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

const QUALITY_OPTIONS: { value: AudioQuality; label: string; description: string }[] = [
  { value: 'auto', label: 'Automatic', description: 'High, or data saver on slow and metered connections' },
  { value: 'high', label: 'High', description: 'Best available, usually Opus ~160 kbps' },
  { value: 'low', label: 'Data saver', description: 'Smallest stream, around 50–70 kbps' },
]

const secondsLabel = (seconds: number) =>
  seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`

/** "45", "2 min", "1.5 h" → seconds (a bare number counts in `bare` seconds' units); null if it isn't a length. */
function parseLength(text: string, bare = 1): string | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|sec|с|сек|m|min|м|мин|h|ч)?\.?$/i.exec(text)
  if (!match) return null
  const unit = (match[2] ?? '').toLowerCase()
  const factor = !unit ? bare : /^(h|ч)$/.test(unit) ? 3600 : /^(m|min|м|мин)$/.test(unit) ? 60 : 1
  const seconds = Math.round(Number(match[1].replace(',', '.')) * factor)
  return seconds > 0 ? String(seconds) : null
}

const playbackBlocks: SettingsBlock[] = [
  group('play-from', [
    {
      id: 'play-from',
      icon: 'tune',
      title: 'Play from',
      // The same dialog as the player's: for one song, open it from the player's menu.
      get value() {
        return preferenceLabel()
      },
      chevron: true,
      onClick: () => showPlayFrom({ song: null }),
    },
  ]),
  group('playback', [
    {
      id: 'quality',
      icon: 'quality',
      title: 'Audio quality',
      select: {
        options: QUALITY_OPTIONS,
        get value() {
          return audioQuality.value
        },
        set(value) {
          audioQuality.value = value as AudioQuality
        },
      },
    },
    {
      id: 'previous-restart',
      icon: 'previous',
      title: 'Previous restarts the song',
      description: 'Pressing Previous after this long starts the song over; before it, goes back a song',
      select: {
        title: 'Previous restarts the song',
        options: [
          { value: 'off', label: 'Never', description: 'Previous always goes back a song' },
          { value: '3', label: 'After 3 seconds' },
          { value: '5', label: 'After 5 seconds' },
          { value: '10', label: 'After 10 seconds' },
          { value: 'full', label: 'Always', description: 'Goes back a song only in the first second' },
        ],
        get value() {
          return previousRestart.value
        },
        set(value) {
          previousRestart.value = value as PreviousRestart
        },
        custom: {
          description: 'Seconds into the song, e.g. 7',
          placeholder: 'Seconds',
          label: (value) => `After ${value} seconds`,
          parse(text) {
            const seconds = Number(text.replace(',', '.').replace(/\s*(s|sec|seconds?|с|сек)\.?$/i, ''))
            return Number.isFinite(seconds) && seconds > 0 ? String(seconds) : null
          },
        },
      },
    },
    {
      id: 'autoplay',
      icon: 'radio',
      title: 'Autoplay',
      description: 'Keep playing similar songs when the queue ends',
      toggle: bool(autoplayRelated),
    },
    {
      id: 'skip-shorter',
      icon: 'timer',
      title: 'Leave out short songs',
      description: 'Autoplay and radios skip songs shorter than this',
      select: {
        title: 'Leave out songs shorter than',
        options: [
          { value: '0', label: 'Never' },
          ...[15, 30, 60, 90, 120].map((seconds) => ({ value: String(seconds), label: secondsLabel(seconds) })),
        ],
        get value() {
          return String(autoSkipShorter.value)
        },
        set(value) {
          autoSkipShorter.value = Number(value)
        },
        custom: {
          description: 'In seconds, or with a unit: 45, 2 min',
          placeholder: 'Length, e.g. 45 or 2 min',
          label: (value) => `Shorter than ${secondsLabel(Number(value))}`,
          parse: parseLength,
        },
      },
    },
    {
      id: 'skip-longer',
      icon: 'hourglass',
      title: 'Leave out long songs',
      description: 'Autoplay and radios skip songs longer than this: mixes, station recordings, hour-long uploads',
      select: {
        title: 'Leave out songs longer than',
        options: [
          { value: '0', label: 'Never' },
          ...[600, 900, 1200, 1800, 3600].map((seconds) => ({ value: String(seconds), label: secondsLabel(seconds) })),
        ],
        get value() {
          return String(autoSkipLonger.value)
        },
        set(value) {
          autoSkipLonger.value = Number(value)
        },
        custom: {
          description: 'In minutes, or with a unit: 25, 90 s',
          placeholder: 'Length, e.g. 25 or 1 h',
          label: (value) => `Longer than ${secondsLabel(Number(value))}`,
          parse: (text) => parseLength(text, 60),
        },
      },
    },
    {
      id: 'skip-failed',
      icon: 'next',
      title: 'Skip songs that fail to play',
      description: 'Move on to the next song when one can\'t be played. Off: playback stops and shows the error.',
      toggle: bool(skipFailed),
    },
    {
      id: 'remember-queue',
      icon: 'queue',
      title: 'Remember queue',
      description: 'Restore the queue and position on launch',
      toggle: bool(persistentQueue),
    },
    {
      id: 'lock-screen',
      icon: 'lockscreen',
      title: 'Lock screen controls',
      get description() {
        return isDesktop
          ? 'Song, play/pause and skip in the system media controls (volume flyout, lock screen). Off: Noctis only reacts to the media keys. Takes effect after a restart.'
          : 'Song, play/pause and skip on the lock screen and in notifications. Also keeps music playing in the background.'
      },
      toggle: bool(mediaControls),
    },
    {
      id: 'keep-awake',
      icon: 'bolt',
      title: 'Keep playing with the screen off',
      description: "Keeps the phone's CPU and Wi-Fi awake while music plays, so a sleeping phone doesn't cut it off. Uses a little more battery.",
      hidden: !hasNoctisPlugin,
      toggle: bool(keepAwake),
    },
  ]),
  group('personal', [
    {
      id: 'pause-history',
      icon: 'history',
      title: 'Pause listening history',
      description: "Don't add songs to Recently played",
      toggle: bool(pauseHistory),
    },
    {
      id: 'live-bars',
      icon: 'equalizer',
      title: 'Animate playing bars with the music',
      get description() {
        return analysisSupported
          ? 'The bars next to the playing song move with the sound. Off: a looping animation. Streams the app can\'t read keep the looping one.'
          : "This device can't read the audio, so the bars keep their looping animation."
      },
      toggle: bool(liveBars),
    },
    { id: 'haptics', icon: 'vibrate', title: 'Haptic feedback', description: 'A soft tap on touches', toggle: bool(hapticsEnabled) },
  ]),
]

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

const LANGUAGES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  tr: 'Türkçe',
  uk: 'Українська',
  'zh-CN': '中文（简体）',
}

const COUNTRIES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  PL: 'Poland',
  BR: 'Brazil',
  MX: 'Mexico',
  JP: 'Japan',
  KR: 'South Korea',
  IN: 'India',
  TR: 'Türkiye',
  UA: 'Ukraine',
  KZ: 'Kazakhstan',
  RU: 'Russia',
}

const options = (record: Record<string, string>) => Object.entries(record).map(([value, label]) => ({ value, label }))

const contentBlocks: SettingsBlock[] = [
  group('service', [
    {
      id: 'service',
      get icon() {
        return activeService.value?.service.icon ?? 'music'
      },
      title: 'Service',
      get description() {
        return activeService.value ? 'Home, search and your library come from here' : 'No service is enabled; see Settings → Plugins'
      },
      get disabled() {
        return Object.keys(services).length < 2
      },
      select: {
        title: 'Service',
        get options() {
          return Object.entries(services).map(([value, service]) => ({ value, label: service.name }))
        },
        get value() {
          return activeService.value?.id ?? activeServiceId.value
        },
        set(value) {
          activeServiceId.value = value
        },
      },
    },
  ]),
  group('content', [
    {
      id: 'language',
      icon: 'language',
      get title() {
        return t('Content language')
      },
      select: {
        title: 'Content language',
        options: options(LANGUAGES),
        get value() {
          return contentLanguage.value
        },
        set(value) {
          contentLanguage.value = value
        },
      },
    },
    {
      id: 'region',
      icon: 'flag',
      title: 'Region',
      select: {
        title: 'Content region',
        options: options(COUNTRIES),
        get value() {
          return contentCountry.value
        },
        set(value) {
          contentCountry.value = value
        },
      },
    },
  ]),
  { id: 'note', type: 'note', text: 'Language and region are passed to services: they change what services recommend and the language of titles and labels.' },
]

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

const CACHE_SIZES = [128, 256, 512, 1024, 2048, 0]
const cacheLabel = (mb: number) => (mb === 0 ? 'Unlimited' : mb >= 1024 ? `${Math.round((mb / 1024) * 100) / 100} GB` : `${mb} MB`)

const storageBlocks: SettingsBlock[] = [
  { id: 'meter', type: 'component', component: StorageMeter },
  { id: 'downloads-header', type: 'header', title: 'Downloads' },
  group('downloads', [
    {
      id: 'downloaded',
      icon: 'downloaded',
      title: 'Downloaded songs',
      get value() {
        return `${songCount(downloads.value.length)} • ${formatBytes(usage.value.download)}`
      },
      chevron: true,
      onClick: () => navigate({ name: 'collection', id: 'downloads' }),
    },
    {
      id: 'download-queue',
      icon: 'downloading',
      title: 'Download queue',
      get value() {
        return batch.active ? batchPosition.value : 'Nothing downloading'
      },
      chevron: true,
      onClick: () => navigate({ name: 'downloads-queue' }),
    },
    {
      id: 'download-concurrency',
      icon: 'layers',
      title: 'Simultaneous downloads',
      description: 'Some services allow fewer at once, or space them out, to avoid being rate limited.',
      select: {
        title: 'Simultaneous downloads',
        options: [1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) })),
        get value() {
          return String(downloadConcurrency.value)
        },
        set(value) {
          downloadConcurrency.value = Number(value)
        },
      },
    },
    {
      id: 'save-liked',
      icon: 'favorite',
      title: 'Save liked songs',
      description: 'What happens to a song when you like it. "Download" also queues the songs you already liked; "Cache" is trimmed with the rest of the cache.',
      select: {
        title: 'Save liked songs',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'cache', label: 'Cache them' },
          { value: 'download', label: 'Download them' },
        ],
        get value() {
          return saveLiked.value
        },
        set(value) {
          saveLiked.value = value as SaveLiked
        },
      },
    },
    {
      id: 'download-notifications',
      icon: 'notifications',
      title: 'Download notifications',
      description: 'Show progress in a notification; tapping it opens the download queue.',
      toggle: bool(downloadNotifications),
    },
    {
      id: 'download-max-length',
      icon: 'hourglass',
      title: 'Longest song to download',
      description: 'Longer ones (mixes, hour-long uploads) are left out when downloading a playlist or album. Stations never are.',
      select: {
        title: 'Longest song to download',
        options: [
          { value: '0', label: 'No limit' },
          ...[10, 30, 60, 120, 180].map((minutes) => ({ value: String(minutes), label: minutes >= 60 ? `${minutes / 60} h` : `${minutes} min` })),
        ],
        get value() {
          return String(downloadMaxMinutes.value)
        },
        set(value) {
          downloadMaxMinutes.value = Number(value)
        },
        custom: {
          description: 'In minutes, or with a unit: 45, 2 h',
          placeholder: 'Length, e.g. 45 or 2 h',
          label: (value) => (Number(value) >= 60 ? `${Math.round((Number(value) / 60) * 10) / 10} h` : `${value} min`),
          parse: (text) => {
            const seconds = parseLength(text, 60)
            return seconds === null ? null : String(Math.max(1, Math.round(Number(seconds) / 60)))
          },
        },
      },
    },
    {
      id: 'remove-downloads',
      icon: 'delete',
      title: 'Remove all downloads',
      destructive: true,
      get disabled() {
        return downloads.value.length === 0
      },
      onClick: () => ask('Remove all downloads?', 'Downloaded songs will need a connection again.', clearDownloads),
    },
  ]),
  { id: 'cache-header', type: 'header', title: 'Cache' },
  group('cache', [
    {
      id: 'save-as-files',
      icon: 'folder',
      title: 'Save as regular files',
      description: 'Downloads and cache are ordinary audio files named after the song, in a folder you can open. Off keeps them in the app\'s hidden webview cache. Applies to songs saved from now on.',
      hidden: !isDesktop,
      toggle: bool(saveAsFiles),
    },
    {
      id: 'show-files',
      icon: 'open-external',
      title: 'Show saved files',
      description: 'Open the folder with downloaded and cached songs',
      hidden: !isDesktop,
      chevron: true,
      async onClick() {
        try {
          const dir = await invoke<string>('offline_dir')
          await revealItemInDir(dir)
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      id: 'cache-enabled',
      icon: 'cached',
      title: 'Cache played songs',
      description: 'Keep songs you play for offline listening. Uses extra data while streaming.',
      toggle: bool(cacheEnabled),
    },
    {
      id: 'cache-size',
      icon: 'storage',
      title: 'Maximum cache size',
      get disabled() {
        return !cacheEnabled.value
      },
      select: {
        title: 'Maximum cache size',
        options: CACHE_SIZES.map((mb) => ({ value: String(mb), label: cacheLabel(mb) })),
        get value() {
          return String(maxCacheMb.value)
        },
        set(value) {
          maxCacheMb.value = Number(value)
        },
        custom: {
          description: 'In MB, or with a unit: 700, 3 GB',
          placeholder: 'Size, e.g. 3 GB',
          label: (value) => cacheLabel(Number(value)),
          parse(text) {
            const match = /^(\d+(?:[.,]\d+)?)\s*(mb|gb|мб|гб)?$/i.exec(text)
            if (!match) return null
            const size = Number(match[1].replace(',', '.')) * (/^(gb|гб)$/i.test(match[2] ?? '') ? 1024 : 1)
            return size > 0 ? String(Math.round(size)) : null
          },
        },
      },
    },
    {
      id: 'clear-cache',
      icon: 'delete',
      title: 'Clear cache',
      get value() {
        return `${songCount(cached.value.length)} • ${formatBytes(usage.value.cache)}`
      },
      get disabled() {
        return cached.value.length === 0
      },
      onClick: () => ask('Clear cache?', 'Cached songs will be streamed again next time.', clearCache),
    },
  ]),
  { id: 'history-header', type: 'header', title: 'History' },
  group('history', [
    {
      id: 'clear-history',
      icon: 'history',
      title: 'Clear listening history',
      get value() {
        return songCount(history.value.length)
      },
      get disabled() {
        return history.value.length === 0
      },
      onClick: () => ask('Clear listening history?', 'Recently played on this device will be emptied.', clearHistory),
    },
    {
      id: 'clear-searches',
      icon: 'search',
      title: 'Clear search history',
      get value() {
        return `${searchHistory.value.length} searches`
      },
      get disabled() {
        return searchHistory.value.length === 0
      },
      onClick: () => ask('Clear search history?', 'Your recent searches will be removed.', clearSearchHistory),
    },
  ]),
]

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

/** What wraps the web app on each platform; the browser has no shell. */
const shell: Partial<Record<typeof platform, string>> = { android: 'Capacitor 8', ios: 'Capacitor 8', desktop: 'Tauri 2' }
const platformLabel = platform === 'web' ? 'Web preview' : platform.charAt(0).toUpperCase() + platform.slice(1)

const aboutBlocks: SettingsBlock[] = [
  { id: 'hero', type: 'component', component: AboutHero },
  group('about', [
    { id: 'version', icon: 'info', title: 'Version', value: '0.2.0' },
    { id: 'built-with', icon: 'code', title: 'Built with', value: `Vue ${vueVersion}${shell[platform] ? ` • ${shell[platform]}` : ''}` },
    { id: 'platform', icon: 'devices', title: 'Platform', value: platformLabel },
  ]),
  { id: 'note', type: 'note', text: "Noctis isn't affiliated with the services its plugins connect to." },
]

export function defineBuiltInSettings() {
  defineSection(
    { id: 'appearance', icon: 'palette', get title() { return t('Appearance') }, description: 'Language, theme, dynamic colour, player' },
    appearanceBlocks,
    'noctis',
  )
  defineSection(
    { id: 'playback', icon: 'equalizer', get title() { return t('Playback') }, description: 'Audio quality, queue, autoplay' },
    playbackBlocks,
    'noctis',
  )
  defineSection({ id: 'content', icon: 'language', get title() { return t('Content') }, description: 'Service, content language and region' }, contentBlocks, 'noctis')
  defineSection(
    { id: 'storage', icon: 'storage', get title() { return t('Storage') }, description: 'Downloads, cache and history' },
    storageBlocks,
    'noctis',
  )
  defineSection({ id: 'about', icon: 'info', get title() { return t('About') }, description: 'Version and credits' }, aboutBlocks, 'noctis')
}
