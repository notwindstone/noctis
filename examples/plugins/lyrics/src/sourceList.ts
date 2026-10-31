import { Noctis } from './host'
import { settings, sources, view } from './state'

const { defineComponent, h, nextTick, ref } = Noctis.packages.vue
const { haptic } = Noctis.libs.haptics

/**
 * The sources, in the order they win ties. Drag the handle to reorder (like Up next);
 * tap a row to switch the source on or off.
 */
export const SourceList = defineComponent({
  name: 'LyricsSourceList',
  setup() {
    const list = ref<HTMLElement | null>(null)
    const dragId = ref<string | null>(null)
    const dragOffset = ref(0)
    const settling = ref(false)
    let startY = 0
    let rowHeight = 56
    let lastTarget = 0

    const shown = () => settings.sourceOrder.filter((id) => sources.has(id))

    function targetFor(from: number, offset: number): number {
      return Math.min(shown().length - 1, Math.max(0, from + Math.round(offset / rowHeight)))
    }

    function shiftOf(id: string, index: number): number {
      if (dragId.value === null) return 0
      const from = shown().indexOf(dragId.value)
      if (id === dragId.value) return dragOffset.value
      const target = targetFor(from, dragOffset.value)
      if (from < index && index <= target) return -rowHeight
      if (target <= index && index < from) return rowHeight
      return 0
    }

    function onDown(event: PointerEvent, id: string) {
      const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.lyr-src-row')
      rowHeight = row?.offsetHeight || 56
      dragId.value = id
      dragOffset.value = 0
      startY = event.clientY
      lastTarget = shown().indexOf(id)
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      haptic('dragStart')
    }

    function onMove(event: PointerEvent) {
      if (dragId.value === null) return
      dragOffset.value = event.clientY - startY
      const target = targetFor(shown().indexOf(dragId.value), dragOffset.value)
      if (target !== lastTarget) {
        lastTarget = target
        haptic('tick')
      }
    }

    async function onUp() {
      const id = dragId.value
      if (id === null) return
      const ids = shown()
      const from = ids.indexOf(id)
      const to = targetFor(from, dragOffset.value)
      haptic('gestureEnd')

      // Where every row is now, so the dropped one glides from under the finger.
      const rows = Array.from(list.value?.querySelectorAll<HTMLElement>('.lyr-src-row') ?? [])
      const before = new Map(rows.map((row) => [row.dataset.id!, row.getBoundingClientRect().top]))
      settling.value = true
      dragId.value = null
      dragOffset.value = 0
      if (to !== from) {
        const moved = ids.slice()
        moved.splice(to, 0, moved.splice(from, 1)[0])
        settings.sourceOrder = [...moved, ...settings.sourceOrder.filter((other) => !sources.has(other))]
      }
      await nextTick()
      for (const row of Array.from(list.value?.querySelectorAll<HTMLElement>('.lyr-src-row') ?? [])) {
        const delta = (before.get(row.dataset.id!) ?? 0) - row.getBoundingClientRect().top
        if (Math.abs(delta) > 1) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
      }
      requestAnimationFrame(() => (settling.value = false))
    }

    function toggle(id: string) {
      haptic(settings.sourcesOff.includes(id) ? 'toggleOn' : 'toggleOff')
      settings.sourcesOff = settings.sourcesOff.includes(id) ? settings.sourcesOff.filter((other) => other !== id) : [...settings.sourcesOff, id]
    }

    return () => {
      const ids = shown()
      return h('div', { class: 'lyr-src' }, [
        h('p', { class: 'lyr-src-hint type-body-small muted' }, 'Drag to set the order. Earlier sources win when two have the same kind of lyrics.'),
        h(
          'ol',
          { ref: list, class: ['settings-group', 'lyr-src-list', settling.value ? 'is-settling' : ''], onPointermove: onMove, onPointerup: onUp, onPointercancel: onUp },
          ids.map((id, index) => {
            const source = sources.get(id)!
            const off = settings.sourcesOff.includes(id)
            const failure = view.failures[id]
            const shift = shiftOf(id, index)
            return h(
              'li',
              {
                key: id,
                'data-id': id,
                class: ['settings-row', 'lyr-src-row', off ? 'is-off' : '', dragId.value === id ? 'is-dragging' : ''],
                style: shift ? { transform: `translate3d(0, ${shift}px, 0)` } : undefined,
              },
              [
                h(
                  'button',
                  { class: 'lyr-src-main', type: 'button', role: 'switch', 'aria-checked': !off, onClick: () => toggle(id) },
                  [
                    h('span', { class: 'settings-row-text' }, [
                      h('span', { class: 'type-body-large' }, `${index + 1}. ${source.name}`),
                      h('span', { class: 'type-body-medium muted' }, failure && !off ? `Last try: ${/failed to fetch|network|load failed/i.test(failure) ? "couldn't reach it" : failure}` : source.description),
                    ]),
                    // The app's switch, check mark and all (SettingsRow.vue), so these match the rows around them.
                    h('span', { class: ['switch', off ? '' : 'is-on'], 'aria-hidden': 'true' }, [h('span', null, off ? [] : [h(Noctis.C.MIcon, { name: 'check', size: 16 })])]),
                  ],
                ),
                h('span', { class: 'lyr-src-handle', 'aria-label': `Move ${source.name}`, onPointerdown: (event: PointerEvent) => onDown(event, id) }, [h(Noctis.C.MIcon, { name: 'drag' })]),
              ],
            )
          }),
        ),
      ])
    }
  },
})
