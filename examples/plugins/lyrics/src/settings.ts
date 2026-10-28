/**
 * Everything the user can change. One reactive object, saved whole; the settings page and
 * the lyrics view both read it, so a change shows up live.
 */

export const SOURCE_IDS = ['local', 'youlyplus', 'betterlyrics', 'musixmatch', 'netease', 'qq', 'kugou', 'lrclib', 'unison', 'genius'] as const

export interface Settings {
  enabled: boolean
  /** Lyrics take the cover's place in the full player. */
  replaceCover: boolean
  /** With no lyrics found, show the cover again. */
  coverFallback: boolean
  /** Tapping the lyrics in the player opens them full screen. */
  tapToExpand: boolean

  /* Sources */
  sourceOrder: string[]
  sourcesOff: string[]
  /** Word-synced beats line-synced beats plain, whatever the order; off: strictly the order. */
  preferSynced: boolean
  sourceTimeout: number
  cacheSize: number

  /* Translation and romanization */
  translate: boolean
  translateTarget: string
  translateProvider: string
  skipOwnLanguage: boolean
  romanize: boolean
  romanizer: string
  libreUrl: string
  libreKey: string
  deeplKey: string
  musixmatchToken: string
  boiduKey: string
  aiKind: 'openai' | 'anthropic'
  aiUrl: string
  aiKey: string
  aiModel: string

  /* Look */
  textSize: number
  fontWeight: number
  align: 'left' | 'center' | 'right'
  background: 'artwork' | 'gradient' | 'plain'
  backgroundMotion: boolean
  subLineScale: number

  /* Animation */
  preset: string
  focus: boolean
  blur: number
  inactiveOpacity: number
  inactiveScale: number
  wordFill: boolean
  wordLift: number
  glow: number
  lineFill: boolean
  scroll: 'spring' | 'smooth' | 'instant'
  stiffness: number
  damping: number
  stagger: number
  anchor: number
  lead: number
  interludes: boolean
  interludeMin: number
  bgVocals: boolean
  resumeDelay: number
  reduceMotion: 'system' | 'on' | 'off'
}

/** The "Apple Music" look. */
export const DEFAULT_ANIMATION = {
  focus: true,
  blur: 3,
  inactiveOpacity: 0.34,
  inactiveScale: 0.94,
  wordFill: true,
  wordLift: 3,
  glow: 0.35,
  lineFill: false,
  scroll: 'spring' as 'spring' | 'smooth' | 'instant',
  stiffness: 170,
  damping: 24,
  stagger: 45,
  anchor: 0.3,
  lead: 0,
  interludes: true,
  interludeMin: 5,
  bgVocals: true,
}

export type AnimationSettings = typeof DEFAULT_ANIMATION

export const PRESETS: Record<string, { label: string; description: string; values: AnimationSettings }> = {
  apple: { label: 'Apple Music', description: 'Blur, spring scroll, rising words', values: DEFAULT_ANIMATION },
  minimal: {
    label: 'Minimal',
    description: 'Clean highlight, no blur or motion on words',
    values: { ...DEFAULT_ANIMATION, blur: 0, inactiveScale: 1, wordLift: 0, glow: 0, stagger: 0, scroll: 'smooth', inactiveOpacity: 0.45 },
  },
  karaoke: {
    label: 'Karaoke',
    description: 'Strong word fill and glow, sharp lines',
    values: { ...DEFAULT_ANIMATION, blur: 0, inactiveOpacity: 0.5, wordLift: 6, glow: 0.8, lineFill: true, stagger: 30, anchor: 0.4 },
  },
  calm: {
    label: 'Calm',
    description: 'Slow, soft spring and gentle blur',
    values: { ...DEFAULT_ANIMATION, blur: 2, stiffness: 80, damping: 18, stagger: 80, wordLift: 1, glow: 0.15, inactiveOpacity: 0.3 },
  },
  static: {
    label: 'Static',
    description: 'No animation: lines jump, nothing moves',
    values: { ...DEFAULT_ANIMATION, blur: 0, inactiveScale: 1, wordFill: false, wordLift: 0, glow: 0, stagger: 0, scroll: 'instant', interludes: false },
  },
}

export const DEFAULTS: Settings = {
  enabled: true,
  replaceCover: true,
  coverFallback: true,
  tapToExpand: true,

  sourceOrder: [...SOURCE_IDS],
  sourcesOff: [],
  preferSynced: true,
  sourceTimeout: 8,
  cacheSize: 300,

  translate: false,
  translateTarget: 'app',
  translateProvider: 'auto',
  skipOwnLanguage: true,
  romanize: false,
  romanizer: 'auto',
  libreUrl: 'https://libretranslate.com',
  libreKey: '',
  deeplKey: '',
  musixmatchToken: '',
  boiduKey: '',
  aiKind: 'openai',
  aiUrl: 'https://api.openai.com/v1',
  aiKey: '',
  aiModel: 'gpt-4o-mini',

  textSize: 1,
  fontWeight: 700,
  align: 'left',
  background: 'artwork',
  backgroundMotion: true,
  subLineScale: 0.5,

  preset: 'apple',
  ...DEFAULT_ANIMATION,
  resumeDelay: 3,
  reduceMotion: 'system',
}

export const TARGET_LANGUAGES: [string, string][] = [
  ['en', 'English'], ['ru', 'Русский'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
  ['it', 'Italiano'], ['uk', 'Українська'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ja', '日本語'], ['ko', '한국어'],
  ['zh', '中文'], ['ar', 'العربية'], ['hi', 'हिन्दी'], ['id', 'Indonesia'],
]
