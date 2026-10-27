import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { computed, ref, watchEffect } from 'vue'
import { hasNoctisPlugin, Noctis } from './native'
import { motion, pureBlack } from './preferences'
import { oneOf, persisted } from './storage'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ColorSource = 'system' | 'seed' | 'artwork'

interface Seed {
  id: string
  name: string
  hue: number
}

/**
 * Material You seeds, expressed as OKLCH hues. Picking one regenerates every
 * colour role in the scheme, similar to Android's wallpaper-based dynamic colour.
 */
export const SEEDS: Seed[] = [
  { id: 'lunar', name: 'Lunar', hue: 300 },
  { id: 'tide', name: 'Tide', hue: 245 },
  { id: 'lagoon', name: 'Lagoon', hue: 200 },
  { id: 'grove', name: 'Grove', hue: 145 },
  { id: 'ember', name: 'Ember', hue: 55 },
  { id: 'rose', name: 'Rose', hue: 5 },
]

export const mode = persisted<ThemeMode>('noctis:mode', 'system', oneOf('system', 'light', 'dark'))
export const seedId = persisted('noctis:seed', 'lunar', (value) => SEEDS.some((seed) => seed.id === value))
export const colorSource = persisted<ColorSource>('noctis:color-source', 'system', oneOf('system', 'seed', 'artwork'))
export const seed = computed(() => SEEDS.find((item) => item.id === seedId.value) ?? SEEDS[0])

/** Hue of the wallpaper accent on Android 12+, when the device exposes one. */
export const systemHue = ref<number | null>(null)
/** Hue extracted from the current song's artwork; set by the player. */
export const artworkHue = ref<number | null>(null)

export const supportsSystemColor = computed(() => systemHue.value !== null)

/** The source actually in use: wallpaper colour falls back to the preset where unavailable. */
export const effectiveColorSource = computed<ColorSource>(() =>
  colorSource.value === 'system' && !supportsSystemColor.value ? 'seed' : colorSource.value,
)

/** The hue every app-wide colour role is generated from. */
export const activeHue = computed(() => {
  if (colorSource.value === 'system' && systemHue.value !== null) return systemHue.value
  if (colorSource.value === 'artwork' && artworkHue.value !== null) return artworkHue.value
  return seed.value.hue
})

const systemDark = ref(
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true,
)

export const isDark = computed(() =>
  mode.value === 'system' ? systemDark.value : mode.value === 'dark',
)

export function setMode(value: ThemeMode) {
  mode.value = value
}

export function setSeed(value: string) {
  if (SEEDS.some((item) => item.id === value)) {
    seedId.value = value
    colorSource.value = 'seed'
  }
}

/* ------------------------------------------------------------------ *
 * OKLCH -> sRGB
 * ------------------------------------------------------------------ */

/** Clamp out-of-gamut colours by reducing chroma, so pastel tones stay true. */
/**
 * Material tones are CIE L* (perceptual lightness of the luminance), not OKLab L. For a
 * neutral colour OKLab L is the cube root of luminance, so convert through Y. Treating
 * tone/100 as OKLab L made tone 6 (dark surface) come out practically black.
 */
function toneToOklabL(tone: number): number {
  const t = Math.min(100, Math.max(0, tone))
  const y = t <= 8 ? t / 903.2963 : ((t + 16) / 116) ** 3
  return Math.cbrt(y)
}

export function oklchHex(tone: number, chroma: number, hue: number): string {
  const lightness = toneToOklabL(tone)
  const radians = (hue * Math.PI) / 180
  let low = 0
  let high = 1
  let rgb = oklabToLinearRgb(lightness, 0, 0)

  for (let i = 0; i < 14; i++) {
    const scale = (low + high) / 2
    const candidate = oklabToLinearRgb(
      lightness,
      chroma * scale * Math.cos(radians),
      chroma * scale * Math.sin(radians),
    )
    if (candidate.every((channel) => channel >= -0.001 && channel <= 1.001)) {
      rgb = candidate
      low = scale
    } else {
      high = scale
    }
  }

  return `#${rgb.map((channel) => toHexByte(channel)).join('')}`
}

function oklabToLinearRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function toHexByte(linear: number): string {
  const value = Math.min(1, Math.max(0, linear))
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
    .toString(16)
    .padStart(2, '0')
}

/* ------------------------------------------------------------------ *
 * Material 3 colour roles
 * ------------------------------------------------------------------ */

type Scheme = Record<string, string>

function schemeFor(seedHue: number, dark: boolean): Scheme {
  const seed = (tone: number, chroma: number) => oklchHex(tone, chroma, seedHue)
  const tertiary = (tone: number, chroma: number) => oklchHex(tone, chroma, (seedHue + 55) % 360)
  const error = (tone: number, chroma: number) => oklchHex(tone, chroma, 25)
  const neutral = (tone: number, chroma: number) => oklchHex(tone, chroma, seedHue)

  if (dark) {
    return {
      primary: seed(80, 0.1),
      onPrimary: seed(20, 0.06),
      primaryContainer: seed(30, 0.09),
      onPrimaryContainer: seed(90, 0.05),
      inversePrimary: seed(40, 0.14),
      secondary: seed(80, 0.045),
      onSecondary: seed(20, 0.03),
      secondaryContainer: seed(30, 0.035),
      onSecondaryContainer: seed(90, 0.025),
      tertiary: tertiary(80, 0.07),
      onTertiary: tertiary(20, 0.04),
      tertiaryContainer: tertiary(30, 0.06),
      onTertiaryContainer: tertiary(90, 0.04),
      error: error(80, 0.12),
      onError: error(20, 0.06),
      errorContainer: error(30, 0.1),
      onErrorContainer: error(90, 0.05),
      background: neutral(6, 0.006),
      onBackground: neutral(90, 0.01),
      surface: neutral(6, 0.006),
      onSurface: neutral(90, 0.01),
      surfaceVariant: neutral(30, 0.02),
      onSurfaceVariant: neutral(80, 0.02),
      surfaceDim: neutral(6, 0.006),
      surfaceBright: neutral(24, 0.012),
      surfaceContainerLowest: neutral(4, 0.005),
      surfaceContainerLow: neutral(10, 0.008),
      surfaceContainer: neutral(12, 0.009),
      surfaceContainerHigh: neutral(17, 0.01),
      surfaceContainerHighest: neutral(22, 0.012),
      outline: neutral(60, 0.02),
      outlineVariant: neutral(30, 0.02),
      inverseSurface: neutral(90, 0.01),
      inverseOnSurface: neutral(20, 0.01),
      scrim: '#000000',
      shadow: '#000000',
    }
  }

  return {
    primary: seed(40, 0.14),
    onPrimary: seed(100, 0.02),
    primaryContainer: seed(90, 0.055),
    onPrimaryContainer: seed(10, 0.06),
    inversePrimary: seed(80, 0.1),
    secondary: seed(40, 0.05),
    onSecondary: seed(100, 0.01),
    secondaryContainer: seed(90, 0.03),
    onSecondaryContainer: seed(10, 0.035),
    tertiary: tertiary(40, 0.09),
    onTertiary: tertiary(100, 0.01),
    tertiaryContainer: tertiary(90, 0.045),
    onTertiaryContainer: tertiary(10, 0.05),
    error: error(40, 0.17),
    onError: error(100, 0.01),
    errorContainer: error(90, 0.06),
    onErrorContainer: error(10, 0.08),
    background: neutral(98, 0.004),
    onBackground: neutral(10, 0.01),
    surface: neutral(98, 0.004),
    onSurface: neutral(10, 0.01),
    surfaceVariant: neutral(90, 0.02),
    onSurfaceVariant: neutral(30, 0.025),
    surfaceDim: neutral(87, 0.012),
    surfaceBright: neutral(98, 0.004),
    surfaceContainerLowest: neutral(100, 0.002),
    surfaceContainerLow: neutral(96, 0.006),
    surfaceContainer: neutral(94, 0.008),
    surfaceContainerHigh: neutral(92, 0.01),
    surfaceContainerHighest: neutral(90, 0.012),
    outline: neutral(50, 0.02),
    outlineVariant: neutral(80, 0.018),
    inverseSurface: neutral(20, 0.01),
    inverseOnSurface: neutral(95, 0.008),
    scrim: '#000000',
    shadow: '#000000',
  }
}

function cssVarName(role: string): string {
  return `--md-sys-color-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

function withPureBlack(scheme: Scheme): Scheme {
  return {
    ...scheme,
    background: '#000000',
    surface: '#000000',
    surfaceDim: '#000000',
    surfaceContainerLowest: '#000000',
    surfaceContainerLow: scheme.surfaceContainerLowest,
    surfaceContainer: scheme.surfaceContainerLow,
  }
}

/** Colour roles as CSS custom properties, for scoping a scheme to one element (the player). */
export function schemeStyle(hue: number, dark = isDark.value): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [role, value] of Object.entries(schemeFor(hue, dark))) {
    style[cssVarName(role)] = value
  }
  return style
}

function applyTheme() {
  const root = document.documentElement
  const base = schemeFor(activeHue.value, isDark.value)
  const scheme = isDark.value && pureBlack.value ? withPureBlack(base) : base

  for (const [role, value] of Object.entries(scheme)) {
    root.style.setProperty(cssVarName(role), value)
  }

  root.dataset.theme = isDark.value ? 'dark' : 'light'
  root.style.colorScheme = isDark.value ? 'dark' : 'light'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', scheme.surface)

  if (Capacitor.isNativePlatform()) {
    // Style.Dark means light glyphs, which is what a dark surface needs.
    StatusBar.setStyle({ style: isDark.value ? Style.Dark : Style.Light }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 * sRGB -> OKLCH hue, for wallpaper and artwork colours
 * ------------------------------------------------------------------ */

function srgbToLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function rgbToOklch(r: number, g: number, b: number): { lightness: number; chroma: number; hue: number } {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { lightness, chroma: Math.hypot(a, bb), hue }
}

export function hexToHue(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return rgbToOklch((value >> 16) & 255, (value >> 8) & 255, value & 255).hue
}

async function loadSystemColors() {
  if (!hasNoctisPlugin) return
  try {
    const colors = await Noctis.getSystemColors()
    systemHue.value = colors.accent ? hexToHue(colors.accent) : null
  } catch {
    systemHue.value = null
  }
}

let initialized = false

export function initTheme() {
  if (initialized) return
  initialized = true

  watchEffect(() => (document.documentElement.dataset.motion = motion.value))

  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (event) => {
      systemDark.value = event.matches
    })

  // The wallpaper may change while the app is in the background.
  void loadSystemColors()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void loadSystemColors()
  })

  watchEffect(() => applyTheme())
}

/** Placeholder artwork gradient for items without a thumbnail. */
export function artwork(hue: number) {
  const dark = isDark.value
  const top = oklchHex(dark ? 70 : 82, 0.11, hue)
  const from = oklchHex(dark ? 44 : 62, 0.13, hue)
  const to = oklchHex(dark ? 20 : 32, 0.09, (hue + 45) % 360)

  return {
    backgroundImage: `radial-gradient(circle at 28% 18%, ${top}, transparent 62%), linear-gradient(145deg, ${from}, ${to})`,
  }
}
