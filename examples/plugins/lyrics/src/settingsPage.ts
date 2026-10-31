import { clearCache } from './engine'
import { Noctis } from './host'
import { DEFAULTS, PRESETS, TARGET_LANGUAGES, type Settings } from './settings'
import { settings } from './state'
import { SourceList } from './sourceList'
import { romanizers, translators } from './translate'

type Row = Record<string, unknown> & { id: string; title: string }

const { ui, snackbar } = Noctis.libs

function labelOf(options: [string | number, string][], value: unknown): string {
  return options.find(([option]) => String(option) === String(value))?.[1] ?? String(value)
}

/** A row that opens a list of choices for one setting. */
function choice<K extends keyof Settings>(key: K, title: string, icon: string, options: [Settings[K], string][] | (() => [Settings[K], string][]), description?: string): Row {
  const list = () => (typeof options === 'function' ? options() : options)
  return {
    id: key,
    icon,
    title,
    description,
    get value() {
      return labelOf(list() as [string | number, string][], settings[key])
    },
    select: {
      title,
      get options() {
        return list().map(([value, label]) => ({ value: String(value), label }))
      },
      get value() {
        return String(settings[key])
      },
      set(value: string) {
        ;(settings as Record<string, unknown>)[key] = typeof DEFAULTS[key] === 'number' ? Number(value) : value
      },
    },
  }
}

function toggle<K extends keyof Settings>(key: K, title: string, icon: string, description?: string): Row {
  return {
    id: key,
    icon,
    title,
    description,
    toggle: {
      get value() {
        return Boolean(settings[key])
      },
      set(value: boolean) {
        ;(settings as Record<string, unknown>)[key] = value
      },
    },
  }
}

/** A row that edits a piece of text (an address, a key) in a dialog. */
function text<K extends 'libreUrl' | 'libreKey' | 'deeplKey' | 'musixmatchToken' | 'boiduKey' | 'aiUrl' | 'aiKey' | 'aiModel'>(key: K, title: string, icon: string, options: { secret?: boolean; description?: string } = {}): Row {
  return {
    id: key,
    icon,
    title,
    description: options.description,
    get value() {
      const value = settings[key]
      if (!value) return 'Not set'
      return options.secret ? `••••${value.slice(-4)}` : value
    },
    onClick: () =>
      ui.showTextDialog({
        title,
        description: options.description,
        password: options.secret,
        confirmLabel: 'Save',
        onConfirm: (value: string) => {
          settings[key] = value.trim() as Settings[K]
        },
      }),
  }
}

const secondsOf = (list: number[], unit = 's'): [number, string][] => list.map((value) => [value, `${value} ${unit}`])

function currentPreset(): string {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if ((Object.keys(preset.values) as (keyof typeof preset.values)[]).every((key) => settings[key] === preset.values[key])) return id
  }
  return 'custom'
}

function presetRow(): Row {
  return {
    id: 'preset',
    icon: 'bolt',
    title: 'Animation preset',
    get description() {
      return PRESETS[currentPreset()]?.description ?? 'Your own mix of the settings below'
    },
    get value() {
      return PRESETS[currentPreset()]?.label ?? 'Custom'
    },
    select: {
      title: 'Animation preset',
      get options() {
        return [...Object.entries(PRESETS).map(([value, preset]) => ({ value, label: preset.label, description: preset.description })), { value: 'custom', label: 'Custom', description: 'Keep the current settings' }]
      },
      get value() {
        return currentPreset()
      },
      set(value: string) {
        const preset = PRESETS[value]
        if (preset) Object.assign(settings, preset.values)
        settings.preset = value
      },
    },
  }
}

export const SECTION = { id: 'lyrics', icon: 'lyrics', title: 'Lyrics', description: 'Sources, translation, romanization and animation' }

export function buildSettings() {
  const { group } = Noctis
  const languageOptions = (): [string, string][] => [['app', 'Same as the app'], ...TARGET_LANGUAGES]

  return [
    group('general', [
      toggle('enabled', 'Show lyrics', 'lyrics', 'Look for lyrics of the song that plays'),
      toggle('replaceCover', 'Lyrics instead of the cover', 'image', 'In the full player. The cover returns when there are no lyrics'),
      toggle('coverFallback', 'Show the cover when there are no lyrics', 'image'),
      toggle('tapToExpand', 'Tap lyrics to open them full screen', 'lyrics'),
    ]),

    { id: 'h-sources', type: 'header' as const, title: 'Sources' },
    { id: 'source-list', type: 'component' as const, component: SourceList },
    group('source-options', [
      toggle('preferSynced', 'Prefer timed lyrics', 'schedule', 'Word-by-word beats line-by-line beats plain text, whatever the order. Off: the first source with lyrics wins'),
      choice('sourceTimeout', 'Give each source', 'schedule', secondsOf([4, 8, 12, 20])),
      choice('cacheSize', 'Remember lyrics for', 'storage', [[100, '100 songs'], [300, '300 songs'], [1000, '1000 songs']]),
      {
        id: 'clear-cache',
        icon: 'delete',
        title: 'Clear remembered lyrics',
        description: 'Also forgets translations, chosen sources and timing, but not attached files',
        destructive: true,
        onClick: async () => {
          await clearCache()
          snackbar.notify('Lyrics cache cleared')
        },
      },
    ]),
    { id: 'n-sources', type: 'note' as const, text: 'NetEase, QQ Music, Musixmatch and Genius need the Android, desktop or iOS app: browsers block their requests. LRCLIB and your own files work everywhere. You can attach a .lrc, .ttml or .srt file to a song from the lyrics screen (⋮).' },

    { id: 'h-translate', type: 'header' as const, title: 'Translation' },
    group('translation', [
      toggle('translate', 'Translate lyrics', 'translate', 'Shown under each line. Also a button on the lyrics screen'),
      choice('translateTarget', 'Translate into', 'language', languageOptions),
      choice('translateProvider', 'Translated by', 'cloud', () => [
        ['auto', 'Automatic'],
        ['source', 'Only what the source ships'],
        ...[...translators.values()].map((t): [string, string] => [t.id, t.name]),
      ], 'Automatic: DeepL or AI when set up, then Google'),
      toggle('skipOwnLanguage', 'Skip lines already in that language', 'check'),
    ]),

    { id: 'h-romanize', type: 'header' as const, title: 'Romanization' },
    group('romanization', [
      toggle('romanize', 'Write lyrics in Latin letters', 'language', 'Romaji, romanized Korean, pinyin and Cyrillic, under each line'),
      choice('romanizer', 'Romanized by', 'cloud', () => [
        ['auto', 'Automatic'],
        ['builtin', 'Built in only'],
        ...[...romanizers.values()].filter((r) => r.id !== 'builtin').map((r): [string, string] => [r.id, r.name]),
      ], "Automatic: the source's own romaji, then built in, then the AI for kanji if it is set up"),
    ]),
    { id: 'n-romanize', type: 'note' as const, text: 'The built-in romanizer reads kana, Hangul, Chinese and Cyrillic. Japanese kanji need a dictionary: NetEase ships romaji for many songs, and the AI provider below can do the rest.' },

    { id: 'h-providers', type: 'header' as const, title: 'Keys and servers' },
    group('providers', [
      text('libreUrl', 'LibreTranslate address', 'cloud', { description: 'A server running LibreTranslate, e.g. https://libretranslate.example.com' }),
      text('libreKey', 'LibreTranslate key', 'password', { secret: true }),
      text('musixmatchToken', 'Musixmatch token', 'password', { secret: true, description: 'Optional: a usertoken from the Musixmatch app. Without it Musixmatch is asked anonymously, which it sometimes refuses' }),
      text('boiduKey', 'BetterLyrics API key', 'password', { secret: true, description: 'From boidu.dev. Turns on the BetterLyrics source' }),
      text('deeplKey', 'DeepL API key', 'password', { secret: true, description: 'Keys ending in :fx use the free API' }),
      choice('aiKind', 'AI service', 'suggest', [['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic']]),
      text('aiUrl', 'AI address', 'cloud', { description: 'OpenAI-compatible: the base URL (…/v1). Anthropic: https://api.anthropic.com' }),
      text('aiKey', 'AI key', 'password', { secret: true }),
      text('aiModel', 'AI model', 'suggest', { description: 'For example gpt-4o-mini, or claude-haiku-5-5 for Anthropic' }),
    ]),

    { id: 'h-look', type: 'header' as const, title: 'Look' },
    group('look', [
      choice('textSize', 'Text size', 'list', [[0.85, 'Small'], [1, 'Normal'], [1.2, 'Large'], [1.45, 'Huge']]),
      choice('fontWeight', 'Text weight', 'list', [[500, 'Regular'], [600, 'Medium'], [700, 'Bold'], [800, 'Heavy']]),
      choice('align', 'Alignment', 'list', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]),
      choice('background', 'Background', 'wallpaper', [['artwork', 'Blurred artwork'], ['gradient', 'Colour from artwork'], ['plain', 'Plain dark']]),
      toggle('backgroundMotion', 'Slowly move the background', 'wallpaper'),
      choice('subLineScale', 'Translation and romaji size', 'list', [[0.4, 'Small'], [0.5, 'Normal'], [0.65, 'Large']]),
    ]),

    { id: 'h-animation', type: 'header' as const, title: 'Animation' },
    group('animation', [
      presetRow(),
      toggle('focus', 'Shrink lines that are not sung', 'bolt'),
      choice('inactiveScale', 'Size of other lines', 'bolt', [[0.85, 'Small'], [0.94, 'Normal'], [1, 'Same']]),
      choice('inactiveOpacity', 'Brightness of other lines', 'bolt', [[0.2, 'Very dim'], [0.34, 'Dim'], [0.5, 'Medium'], [0.7, 'Bright']]),
      choice('blur', 'Blur other lines', 'bolt', [[0, 'Off'], [1.5, 'Light'], [3, 'Medium'], [6, 'Strong'], [10, 'Heavy']]),
      toggle('wordFill', 'Fill words as they are sung', 'bolt', 'Needs word-by-word lyrics (NetEase, Musixmatch, TTML)'),
      choice('wordLift', 'Word lift', 'bolt', [[0, 'None'], [1, 'Subtle'], [3, 'Normal'], [6, 'High'], [10, 'Bouncy']]),
      choice('glow', 'Glow on the sung word', 'bolt', [[0, 'None'], [0.15, 'Subtle'], [0.35, 'Normal'], [0.6, 'Strong'], [0.9, 'Neon']]),
      toggle('lineFill', 'Fill whole lines over their time', 'bolt', 'For line-by-line lyrics, which have no word times'),
      choice('scroll', 'Scrolling', 'bolt', [['spring', 'Spring'], ['smooth', 'Smooth'], ['instant', 'Jump']]),
      choice('stiffness', 'Spring stiffness', 'bolt', [[80, 'Soft'], [170, 'Normal'], [260, 'Snappy'], [380, 'Stiff']]),
      choice('damping', 'Spring bounce', 'bolt', [[14, 'Bouncy'], [24, 'Normal'], [34, 'Tight']]),
      choice('stagger', 'Delay between lines', 'bolt', [[0, 'None'], [25, 'Short'], [45, 'Normal'], [80, 'Long'], [120, 'Very long']], 'How much later each following line moves'),
      choice('anchor', 'Where the current line rests', 'bolt', [[0.15, 'Top'], [0.3, 'Upper third'], [0.45, 'Middle']]),
      choice('lead', 'Show lines early by', 'schedule', [[-200, '−0.2 s (later)'], [0, 'Exactly'], [150, '0.15 s'], [300, '0.3 s'], [500, '0.5 s']]),
      toggle('interludes', 'Dots in instrumental breaks', 'bolt'),
      choice('interludeMin', 'Break is at least', 'schedule', secondsOf([3, 5, 8, 12])),
      toggle('bgVocals', 'Show background vocals', 'bolt'),
      choice('resumeDelay', 'Follow the song again after scrolling', 'schedule', secondsOf([1, 3, 5, 8])),
      choice('reduceMotion', 'Reduce motion', 'bolt', [['system', 'Follow the system'], ['on', 'Always'], ['off', 'Never']]),
      {
        id: 'reset-animation',
        icon: 'refresh',
        title: 'Reset animation',
        destructive: true,
        onClick: () => {
          Object.assign(settings, PRESETS.apple.values)
          settings.preset = 'apple'
        },
      },
    ]),
  ]
}

