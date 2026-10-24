import { ref, watch, type WatchStopHandle } from 'vue'
import glassCore from '@sohumsuthar/liquid-glass/css/liquid-glass-core.css?raw'
import { mountFilters, unmountFilters } from './glass'
import type { PluginScope } from './host'
import iosCss from './ios.css?raw'
import TabBar from './TabBar.vue'

/**
 * Liquid Glass: an iOS-style skin for Noctis.
 *
 * - The tab bar becomes a floating glass capsule (registry: BottomNav), with the mini
 *   player sitting on glass of its own.
 * - Everything else is restyled with CSS scoped to `html.lg-ios`: iOS colours (by
 *   overriding the Material colour roles the app's CSS uses), typography, grouped
 *   lists, switches, sheets and alerts.
 *
 * All of it is undone on disable.
 */

const ROOT_CLASS = 'lg-ios'

/** Apple's system colours (dark, light). */
const ACCENTS: Record<string, { label: string; dark: string; light: string }> = {
  red: { label: 'Music red', dark: '#fa2d48', light: '#fa233b' },
  pink: { label: 'Pink', dark: '#ff375f', light: '#ff2d55' },
  blue: { label: 'Blue', dark: '#0a84ff', light: '#007aff' },
  purple: { label: 'Purple', dark: '#bf5af2', light: '#af52de' },
  orange: { label: 'Orange', dark: '#ff9f0a', light: '#ff9500' },
  green: { label: 'Green', dark: '#30d158', light: '#34c759' },
}

export default function liquidGlass({ Plugin, Noctis }: PluginScope) {
  const { isDark } = Noctis.libs.theme
  const { group } = Noctis

  const accent = ref<string>(Plugin.storage.get('accent', 'red') as string)
  /** SVG lensing at the glass edges. Costs GPU time on every frame the glass moves over. */
  const refraction = ref(Plugin.storage.get('refraction', true) as boolean)
  /** Colour fringes in the lensing (three filter passes instead of one). */
  const dispersion = ref(Plugin.storage.get('dispersion', false) as boolean)

  let style: HTMLStyleElement | null = null
  let stops: WatchStopHandle[] = []

  const root = document.documentElement

  function applyAccent() {
    const colours = ACCENTS[accent.value] ?? ACCENTS.red
    root.style.setProperty('--ios-accent-dark', colours.dark)
    root.style.setProperty('--ios-accent-light', colours.light)
  }

  function attach() {
    style = document.createElement('style')
    style.dataset.plugin = Plugin.id
    style.textContent = `${glassCore}\n${iosCss}`
    document.head.appendChild(style)

    root.classList.add(ROOT_CLASS)
    stops = [
      // The glass CSS keys its light/dark looks off html.dark.
      watch(isDark, (dark) => root.classList.toggle('dark', dark), { immediate: true }),
      watch(accent, applyAccent, { immediate: true }),
      watch(refraction, (on) => root.classList.toggle('lg-refract', on), { immediate: true }),
      watch(dispersion, (on) => mountFilters(on ? 6 : 0), { immediate: true }),
    ]

    Plugin.registerComponent('BottomNav', TabBar)
    Plugin.defineSection(SECTION, blocks)
  }

  function detach() {
    for (const stop of stops) stop()
    stops = []
    Plugin.restoreComponent('BottomNav')
    Plugin.removeSection(SECTION.id)
    unmountFilters()
    style?.remove()
    style = null
    root.classList.remove(ROOT_CLASS, 'dark', 'lg-refract')
    root.style.removeProperty('--ios-accent-dark')
    root.style.removeProperty('--ios-accent-light')
  }

  const SECTION = { id: 'liquid-glass', icon: 'palette', title: 'Liquid Glass', description: 'iOS look, glass and accent colour' }

  const blocks = [
    group('look', [
      {
        id: 'accent',
        icon: 'palette',
        title: 'Accent colour',
        select: {
          options: Object.entries(ACCENTS).map(([value, { label }]) => ({ value, label })),
          get value() {
            return accent.value
          },
          set(value: string) {
            accent.value = value
            Plugin.storage.set('accent', value)
          },
        },
      },
    ]),
    { id: 'glass-header', type: 'header' as const, title: 'Glass' },
    group('glass', [
      {
        id: 'refraction',
        icon: 'contrast',
        title: 'Refraction',
        description: 'Bend what is behind the glass at its edges. Turn off if scrolling stutters.',
        toggle: {
          get value() {
            return refraction.value
          },
          set(value: boolean) {
            refraction.value = value
            Plugin.storage.set('refraction', value)
          },
        },
      },
      {
        id: 'dispersion',
        icon: 'paint',
        title: 'Colour fringes',
        description: 'Split the refraction into colours, like real glass. Heavier on the GPU.',
        get disabled() {
          return !refraction.value
        },
        toggle: {
          get value() {
            return dispersion.value
          },
          set(value: boolean) {
            dispersion.value = value
            Plugin.storage.set('dispersion', value)
          },
        },
      },
    ]),
    { id: 'note', type: 'note' as const, text: 'Glass by @sohumsuthar/liquid-glass (MIT). Material You colour settings have no effect while this plugin is on.' },
  ]

  Plugin.subscribe('lifecycle::disable', detach)
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
}
