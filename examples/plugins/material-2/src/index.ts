import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { ref, watch, type WatchStopHandle } from 'vue'
import materialCss from './material.css?raw'
import type { PluginScope } from './host'

const ROOT_CLASS = 'm2'
const SURFACE_CLASS = 'm2-appbar-surface'
const RIPPLE_CLASS = 'm2-ripple'
const DEFAULT_PALETTE = 'indigo'

interface Colors {
  primary: string
  primaryDark: string
  accent: string
  onPrimary: string
  onAccent: string
}

interface Palette {
  label: string
  light: Colors
  dark: Colors
}

const PALETTES: Record<string, Palette> = {
  indigo: {
    label: 'Indigo',
    light: { primary: '#3f51b5', primaryDark: '#303f9f', accent: '#ff4081', onPrimary: '#ffffff', onAccent: '#ffffff' },
    dark: { primary: '#7986cb', primaryDark: '#5c6bc0', accent: '#ff4081', onPrimary: '#000000', onAccent: '#ffffff' },
  },
  blue: {
    label: 'Blue',
    light: { primary: '#1976d2', primaryDark: '#1565c0', accent: '#ff4081', onPrimary: '#ffffff', onAccent: '#ffffff' },
    dark: { primary: '#64b5f6', primaryDark: '#42a5f5', accent: '#ff80ab', onPrimary: '#000000', onAccent: '#000000' },
  },
  teal: {
    label: 'Teal',
    light: { primary: '#009688', primaryDark: '#00796b', accent: '#ffc107', onPrimary: '#ffffff', onAccent: '#000000' },
    dark: { primary: '#4db6ac', primaryDark: '#26a69a', accent: '#ffd54f', onPrimary: '#000000', onAccent: '#000000' },
  },
  pink: {
    label: 'Pink',
    light: { primary: '#e91e63', primaryDark: '#c2185b', accent: '#03dac6', onPrimary: '#ffffff', onAccent: '#000000' },
    dark: { primary: '#f06292', primaryDark: '#ec407a', accent: '#80cbc4', onPrimary: '#000000', onAccent: '#000000' },
  },
  'deep-orange': {
    label: 'Deep orange',
    light: { primary: '#ff5722', primaryDark: '#e64a19', accent: '#00bcd4', onPrimary: '#ffffff', onAccent: '#000000' },
    dark: { primary: '#ff8a65', primaryDark: '#ff7043', accent: '#4dd0e1', onPrimary: '#000000', onAccent: '#000000' },
  },
  green: {
    label: 'Green',
    light: { primary: '#4caf50', primaryDark: '#388e3c', accent: '#ffc107', onPrimary: '#ffffff', onAccent: '#000000' },
    dark: { primary: '#81c784', primaryDark: '#66bb6a', accent: '#ffd54f', onPrimary: '#000000', onAccent: '#000000' },
  },
  purple: {
    label: 'Purple',
    light: { primary: '#9c27b0', primaryDark: '#7b1fa2', accent: '#ff4081', onPrimary: '#ffffff', onAccent: '#ffffff' },
    dark: { primary: '#ba68c8', primaryDark: '#ab47bc', accent: '#ff80ab', onPrimary: '#000000', onAccent: '#000000' },
  },
  baseline: {
    label: 'Material baseline',
    light: { primary: '#6200ee', primaryDark: '#3700b3', accent: '#03dac6', onPrimary: '#ffffff', onAccent: '#000000' },
    dark: { primary: '#bb86fc', primaryDark: '#9a67ea', accent: '#03dac6', onPrimary: '#000000', onAccent: '#000000' },
  },
}

const SECTION = { id: 'material-2', icon: 'palette', title: 'Material 2', description: 'Material Design 2 colours, depth and controls' }

export default function materialTwo({ Plugin, Noctis }: PluginScope) {
  const { isDark, activeHue } = Noctis.libs.theme
  const { pureBlack } = Noctis.libs.preferences
  const { group } = Noctis
  const root = document.documentElement
  const native = Capacitor.isNativePlatform()

  const stored = Plugin.storage.get<string>('palette', DEFAULT_PALETTE)
  const palette = ref(stored && PALETTES[stored] ? stored : DEFAULT_PALETTE)
  const coloredAppBar = ref(Plugin.storage.get<boolean>('coloredAppBar', true) ?? true)
  const ripple = ref(Plugin.storage.get<boolean>('ripple', true) ?? true)

  let style: HTMLStyleElement | null = null
  let stops: WatchStopHandle[] = []

  function applyPalette() {
    const colors = PALETTES[palette.value] ?? PALETTES[DEFAULT_PALETTE]
    root.style.setProperty('--m2-palette-primary', colors.light.primary)
    root.style.setProperty('--m2-palette-primary-dark', colors.light.primaryDark)
    root.style.setProperty('--m2-palette-accent', colors.light.accent)
    root.style.setProperty('--m2-palette-on-primary', colors.light.onPrimary)
    root.style.setProperty('--m2-palette-on-accent', colors.light.onAccent)
    root.style.setProperty('--m2-palette-dark-primary', colors.dark.primary)
    root.style.setProperty('--m2-palette-dark-primary-dark', colors.dark.primaryDark)
    root.style.setProperty('--m2-palette-dark-accent', colors.dark.accent)
    root.style.setProperty('--m2-palette-dark-on-primary', colors.dark.onPrimary)
    root.style.setProperty('--m2-palette-dark-on-accent', colors.dark.onAccent)
  }

  function syncClasses() {
    root.classList.toggle(SURFACE_CLASS, !coloredAppBar.value)
    root.classList.toggle(RIPPLE_CLASS, ripple.value)
  }

  function appBarColor(): string {
    if (!coloredAppBar.value) return isDark.value ? '#1e1e1e' : '#ffffff'
    const colors = PALETTES[palette.value] ?? PALETTES[DEFAULT_PALETTE]
    return isDark.value ? colors.dark.primary : colors.light.primary
  }

  function updateMeta() {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', appBarColor())
  }

  function syncStatusBar() {
    if (!native) return
    const lightGlyphs = coloredAppBar.value ? !isDark.value : isDark.value
    StatusBar.setStyle({ style: lightGlyphs ? Style.Dark : Style.Light }).catch(() => {})
  }

  function attach() {
    if (!style) {
      style = document.createElement('style')
      style.dataset.plugin = Plugin.id
      style.textContent = materialCss
      document.head.appendChild(style)
    }

    root.classList.add(ROOT_CLASS)
    applyPalette()
    syncClasses()
    stops = [
      watch(palette, applyPalette),
      watch(coloredAppBar, syncClasses),
      watch(ripple, syncClasses),
      watch([isDark, activeHue, pureBlack, palette, coloredAppBar], () => {
        updateMeta()
        syncStatusBar()
      }, { immediate: true }),
    ]
    Plugin.defineSection(SECTION, blocks)
  }

  function detach() {
    for (const stop of stops) stop()
    stops = []
    Plugin.removeSection(SECTION.id)
    style?.remove()
    style = null
    root.classList.remove(ROOT_CLASS, SURFACE_CLASS, RIPPLE_CLASS)
    for (const name of [
      '--m2-palette-primary',
      '--m2-palette-primary-dark',
      '--m2-palette-accent',
      '--m2-palette-on-primary',
      '--m2-palette-on-accent',
      '--m2-palette-dark-primary',
      '--m2-palette-dark-primary-dark',
      '--m2-palette-dark-accent',
      '--m2-palette-dark-on-primary',
      '--m2-palette-dark-on-accent',
    ]) {
      root.style.removeProperty(name)
    }
    const surface = getComputedStyle(root).getPropertyValue('--md-sys-color-surface').trim()
    if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface)
    if (native) StatusBar.setStyle({ style: isDark.value ? Style.Dark : Style.Light }).catch(() => {})
  }

  const blocks = [
    group('look', [
      {
        id: 'palette',
        icon: 'palette',
        title: 'Primary colour',
        select: {
          title: 'Primary colour',
          options: Object.entries(PALETTES).map(([value, { label }]) => ({ value, label })),
          get value() {
            return palette.value
          },
          set(value: string) {
            palette.value = value
            Plugin.storage.set('palette', value)
          },
        },
      },
      {
        id: 'colored-app-bar',
        icon: 'contrast',
        title: 'Coloured app bar',
        description: 'Put the primary colour behind the top app bar and search',
        toggle: {
          get value() {
            return coloredAppBar.value
          },
          set(value: boolean) {
            coloredAppBar.value = value
            Plugin.storage.set('coloredAppBar', value)
          },
        },
      },
      {
        id: 'ripple',
        icon: 'touch-app',
        title: 'Touch ripples',
        description: 'A press ripple on lists, cards and buttons',
        toggle: {
          get value() {
            return ripple.value
          },
          set(value: boolean) {
            ripple.value = value
            Plugin.storage.set('ripple', value)
          },
        },
      },
    ]),
    {
      id: 'note',
      type: 'note' as const,
      text: 'A Material Design 2 (2014) skin: Roboto, a coloured app bar, 4px corners, elevation shadows and flat lists. Material You colour settings are ignored while this is on.',
    },
  ]

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  Plugin.log('Material 2 is on. Pick a palette in Settings → Material 2.')
}
