import { Capacitor } from '@capacitor/core'
import { version as vueVersion } from 'vue'
import AboutHero from '../components/settings/AboutHero.vue'
import SeedSwatches from '../components/settings/SeedSwatches.vue'
import StorageMeter from '../components/settings/StorageMeter.vue'
import { clearHistory, clearSearchHistory, history, searchHistory } from '../library'
import { cached, clearCache, clearDownloads, downloads, formatBytes, usage } from '../offline'
import { preferenceLabel } from '../playFrom'
import { defineSection, group, type SettingsBlock } from '../plugins/rows'
import {
  audioQuality,
  autoplayRelated,
  cacheEnabled,
  contentCountry,
  contentLanguage,
  hapticsEnabled,
  maxCacheMb,
  keepAwake,
  mediaControls,
  pauseHistory,
  persistentQueue,
  playerArtworkColors,
  pureBlack,
  type AudioQuality,
} from '../preferences'
import { colorSource, effectiveColorSource, isDark, mode, supportsSystemColor, type ColorSource, type ThemeMode } from '../theme'
import { hasNoctisPlugin } from '../native'
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
      id: 'autoplay',
      icon: 'radio',
      title: 'Autoplay',
      description: 'Keep playing similar songs when the queue ends',
      toggle: bool(autoplayRelated),
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
      description:
        'Song, play/pause and skip on the lock screen and in notifications. Also keeps music playing in the background.',
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
      title: 'Language',
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
      icon: 'tune',
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
  { id: 'note', type: 'note', text: 'Language and region are passed to services: they change what YouTube Music recommends and the language of titles and labels.' },
]

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

const CACHE_SIZES = [128, 256, 512, 1024, 2048, 0]
const cacheLabel = (mb: number) => (mb === 0 ? 'Unlimited' : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`)

const storageBlocks: SettingsBlock[] = [
  { id: 'meter', type: 'component', component: StorageMeter },
  { id: 'downloads-header', type: 'header', title: 'Downloads' },
  group('downloads', [
    {
      id: 'downloaded',
      icon: 'downloaded',
      title: 'Downloaded songs',
      get value() {
        return `${downloads.value.length} songs · ${formatBytes(usage.value.download)}`
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
      },
    },
    {
      id: 'clear-cache',
      icon: 'delete',
      title: 'Clear cache',
      get value() {
        return `${cached.value.length} songs · ${formatBytes(usage.value.cache)}`
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
        return `${history.value.length} songs`
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

const platform = Capacitor.getPlatform()
const platformLabel = platform === 'web' ? 'Web preview' : platform.charAt(0).toUpperCase() + platform.slice(1)

const aboutBlocks: SettingsBlock[] = [
  { id: 'hero', type: 'component', component: AboutHero },
  group('about', [
    { id: 'version', icon: 'info', title: 'Version', value: '0.2.0' },
    { id: 'built-with', icon: 'code', title: 'Built with', value: `Vue ${vueVersion} · Capacitor 8` },
    { id: 'platform', icon: 'tune', title: 'Platform', value: platformLabel },
  ]),
  { id: 'note', type: 'note', text: 'Noctis is not affiliated with YouTube or Google. Inspired by InnerTune and ArchiveTune.' },
]

export function defineBuiltInSettings() {
  defineSection(
    { id: 'appearance', icon: 'palette', title: 'Appearance', description: 'Theme, dynamic colour, player' },
    appearanceBlocks,
    'noctis',
  )
  defineSection(
    { id: 'playback', icon: 'equalizer', title: 'Playback', description: 'Audio quality, queue, autoplay' },
    playbackBlocks,
    'noctis',
  )
  defineSection({ id: 'content', icon: 'language', title: 'Content', description: 'Service, language and region' }, contentBlocks, 'noctis')
  defineSection(
    { id: 'storage', icon: 'storage', title: 'Storage', description: 'Downloads, cache and history' },
    storageBlocks,
    'noctis',
  )
  defineSection({ id: 'about', icon: 'info', title: 'About', description: 'Version and credits' }, aboutBlocks, 'noctis')
}
