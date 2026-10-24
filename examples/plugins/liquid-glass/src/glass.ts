import { defineComponent, h } from 'vue'
import { buildDisplacementLUT, dispersionScales, renderDisplacementMap } from '@sohumsuthar/liquid-glass/optics'

/**
 * Liquid Glass, from @sohumsuthar/liquid-glass without its React components: its CSS
 * material and its optics model, which ray-traces the displacement map the SVG
 * refraction filters use. The map is rendered here on a canvas instead of shipped as
 * a PNG.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Map geometry the library's CSS is calibrated for (48/512 bezel, scale 0.1). */
const SIZE = 512
const BEZEL = 48
const SCALE = 0.1

/* Keep one colour channel (and alpha), for the per-channel dispersion passes. */
const ONLY_RED = '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
const ONLY_GREEN = '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'
const ONLY_BLUE = '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'

function displacementMap(): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) return ''
  const image = context.createImageData(SIZE, SIZE)
  const { lut } = buildDisplacementLUT(255)
  renderDisplacementMap(image.data, { width: SIZE, height: SIZE, radius: BEZEL, bezel: BEZEL, lut, channelDepth: 127 })
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

function el(name: string, attributes: Record<string, string | number>, children: Element[] = []): Element {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  for (const child of children) node.appendChild(child)
  return node
}

/** One refraction filter: the map, then a displacement per colour channel when `dispersion` > 0. */
function filter(id: string, map: string, dispersion: number): Element {
  const image = el('feImage', { href: map, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', result: 'map' })
  const displace = (scale: number, result?: string) =>
    el('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', ...(result ? { result } : {}) })
  const steps: Element[] = [image]
  if (dispersion > 0) {
    const ca = dispersionScales(dispersion)
    steps.push(
      displace(SCALE * ca.red, 'dR'),
      el('feColorMatrix', { in: 'dR', type: 'matrix', values: ONLY_RED, result: 'cR' }),
      displace(SCALE, 'dG'),
      el('feColorMatrix', { in: 'dG', type: 'matrix', values: ONLY_GREEN, result: 'cG' }),
      displace(SCALE * ca.blue, 'dB'),
      el('feColorMatrix', { in: 'dB', type: 'matrix', values: ONLY_BLUE, result: 'cB' }),
      el('feBlend', { in: 'cR', in2: 'cG', mode: 'screen', result: 'cRG' }),
      el('feBlend', { in: 'cRG', in2: 'cB', mode: 'screen' }),
    )
  } else {
    steps.push(displace(SCALE))
  }
  return el(
    'filter',
    { id, x: '0%', y: '0%', width: '100%', height: '100%', filterUnits: 'objectBoundingBox', primitiveUnits: 'objectBoundingBox', 'color-interpolation-filters': 'sRGB' },
    steps,
  )
}

let defs: Element | null = null
let cachedMap = ''

/** Mount the #lg-refract (large surfaces) and #lg-refract-sm filters the CSS refers to. */
export function mountFilters(dispersion = 0) {
  unmountFilters()
  cachedMap ||= displacementMap()
  if (!cachedMap) return
  defs = el('svg', { 'aria-hidden': 'true', width: 0, height: 0, style: 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none' }, [
    filter('lg-refract', cachedMap, dispersion),
    filter('lg-refract-sm', cachedMap, 0),
  ])
  document.body.appendChild(defs)
}

export function unmountFilters() {
  defs?.remove()
  defs = null
}

/**
 * A glass surface: the library's four layers (refraction, tint, rim, content). Nothing
 * above it may set transform, opacity, filter, will-change or contain, or the
 * refraction has no backdrop to sample (see liquid-glass-core.css).
 */
export const Glass = defineComponent({
  name: 'Glass',
  inheritAttrs: true,
  props: {
    tag: { type: String, default: 'div' },
    /** Larger surfaces: deeper shadow, stronger lensing. */
    macro: Boolean,
    /** Frosted, more opaque: for text-heavy surfaces. */
    regular: Boolean,
    /** Flexes and lights up when pressed. */
    interactive: Boolean,
  },
  setup(props, { slots }) {
    return () =>
      h(props.tag, { class: ['liquid-glass', { 'lg-macro': props.macro, 'lg-regular': props.regular, 'lg-interactive': props.interactive }] }, [
        h('div', { class: 'liquid-glass-effect', 'aria-hidden': 'true' }),
        h('div', { class: 'liquid-glass-tint', 'aria-hidden': 'true' }),
        h('div', { class: 'liquid-glass-shine', 'aria-hidden': 'true' }),
        h('div', { class: 'liquid-glass-content' }, slots.default?.()),
      ])
  },
})
