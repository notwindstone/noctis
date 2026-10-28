import { Noctis } from './host'
import { romanizations, settings, translations, view } from './state'
import type { Line, Lyrics } from './types'

const { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } = Noctis.packages.vue
const { player, ui } = Noctis.libs

/* ------------------------------------------------------------------ *
 * What to draw
 * ------------------------------------------------------------------ */

interface Item {
  key: string
  line: Line
  /** Index in `lyrics.lines`; -1 for a break the view added. */
  src: number
  kind: 'line' | 'bg' | 'dots'
  start: number
  end: number
}

/** Lines plus instrumental breaks (empty lines, long gaps, a long intro). */
function buildItems(lyrics: Lyrics | null): Item[] {
  if (!lyrics) return []
  const items: Item[] = []
  const synced = lyrics.sync !== 'none'

  const dots = (start: number, end: number, key: string): Item => ({
    key,
    kind: 'dots',
    src: -1,
    start,
    end,
    line: { start, end, text: '', interlude: true },
  })

  let lastEnd = 0
  lyrics.lines.forEach((line, src) => {
    if (!synced) {
      items.push({ key: `p${src}`, kind: 'line', src, start: -1, end: -1, line })
      return
    }
    if (!line.text.trim()) {
      if (settings.interludes && line.end - line.start > 1) items.push(dots(line.start, line.end, `d${src}`))
      lastEnd = Math.max(lastEnd, line.end)
      return
    }
    if (line.bg && !settings.bgVocals) return
    if (!line.bg && settings.interludes && line.start - lastEnd >= settings.interludeMin) {
      const previous = items[items.length - 1]
      if (!previous || previous.kind !== 'dots') items.push(dots(lastEnd, line.start, `g${src}`))
    }
    items.push({ key: `l${src}`, kind: line.bg ? 'bg' : 'line', src, start: line.start, end: line.end, line })
    if (!line.bg) lastEnd = Math.max(lastEnd, line.end)
  })
  return items
}

/** Syllables that belong to one word stay together when the line wraps. */
function groupWords(line: Line, hWord: (index: number, text: string) => unknown) {
  const groups: unknown[][] = []
  let current: unknown[] = []
  line.words!.forEach((word, index) => {
    current.push(hWord(index, word.text))
    if (/\s$/.test(word.text) || /^\s/.test(line.words![index + 1]?.text ?? '') || index === line.words!.length - 1) {
      groups.push(current)
      current = []
    }
  })
  return groups.map((children) => h('span', { class: 'lyr-group' }, children as never))
}

/* ------------------------------------------------------------------ *
 * The lyrics pane
 * ------------------------------------------------------------------ */

interface Row {
  el: HTMLElement
  words: { el: HTMLElement; start: number; end: number }[]
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export const LyricsPane = defineComponent({
  name: 'LyricsPane',
  props: { mode: { type: String, default: 'inline' } },
  emits: ['tap'],
  setup(props, { emit }) {
    const full = computed(() => props.mode === 'full')
    const viewport = ref<HTMLElement | null>(null)
    const track = ref<HTMLElement | null>(null)

    const items = computed(() => buildItems(view.lyrics))
    const plain = computed(() => !view.lyrics || view.lyrics.sync === 'none')

    const reduced = computed(() => {
      if (settings.reduceMotion === 'on') return true
      if (settings.reduceMotion === 'off') return false
      return Noctis.libs.preferences.motion.value === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches
    })

    /* ---------- layout, measured after every render ---------- */

    let rows: Row[] = []
    let tops: number[] = []
    let viewportHeight = 0
    let trackHeight = 0

    function collect() {
      const track$ = track.value
      if (!track$) return
      const els = Array.from(track$.querySelectorAll<HTMLElement>('[data-i]'))
      rows = els.map((el) => {
        const item = items.value[Number(el.dataset.i)]
        const spans = Array.from(el.querySelectorAll<HTMLElement>('.lyr-word'))
        const timings = item?.line.words?.length ? item.line.words : item ? [{ start: item.start, end: item.end, text: '' }] : []
        return {
          el,
          words: spans.map((span, index) => ({ el: span, start: timings[index]?.start ?? 0, end: timings[index]?.end ?? 0 })),
        }
      })
      measure()
      lastSignature = ''
      wake()
    }

    function measure() {
      const el = viewport.value
      if (!el) return
      viewportHeight = el.clientHeight
      trackHeight = track.value?.offsetHeight ?? 0
      tops = rows.map((row) => row.el.offsetTop)
    }

    /* ---------- time ---------- */

    let lastBase = -1
    let stamp = 0
    function timeNow(now: number): number {
      const base = player.position.value
      if (base !== lastBase) {
        lastBase = base
        stamp = now
      }
      const ahead = player.isPlaying.value ? Math.min((now - stamp) / 1000, 1) : 0
      return base + ahead + (view.offset + settings.lead) / 1000
    }

    /* ---------- states ---------- */

    let lastSignature = ''
    let current = -1
    let activeSet: number[] = []
    let painted: number[] = []

    function findCurrent(t: number): number {
      const list = items.value
      let low = 0
      let high = list.length - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (list[mid].start <= t) {
          found = mid
          low = mid + 1
        } else high = mid - 1
      }
      while (found > 0 && list[found].kind === 'bg') found--
      return found >= 0 && list[found].kind === 'bg' ? -1 : found
    }

    function applyStates(t: number) {
      const list = items.value
      const next = findCurrent(t)
      const act: number[] = []
      for (let i = Math.max(0, next - 3); i < Math.min(list.length, next + 5); i++) {
        if (i === next || (list[i].start <= t && t < list[i].end)) act.push(i)
      }
      // An empty gap between lines keeps the last line lit rather than going dark.
      const signature = `${next}|${act.join(',')}|${rows.length}`
      if (signature === lastSignature) return false
      lastSignature = signature
      current = next
      activeSet = act
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i].el
        const isActive = act.includes(i)
        const distance = isActive ? 0 : act.length ? Math.min(...act.map((a) => Math.abs(a - i))) : Math.abs(i - Math.max(next, 0)) + 1
        el.classList.toggle('is-active', isActive)
        el.classList.toggle('is-near', !isActive && distance === 1)
        el.style.setProperty('--d', String(Math.min(distance, 6)))
        el.style.setProperty('--rel', String(clamp(i - Math.max(next, 0), 0, 6)))
      }
      return true
    }

    function paint(t: number) {
      // Finish the lines that just left, then draw the ones that are lit.
      const todo = new Set([...painted, ...activeSet])
      for (const i of todo) {
        const row = rows[i]
        if (!row) continue
        const lit = activeSet.includes(i)
        for (const word of row.words) {
          const span = Math.max(word.end - word.start, 0.05)
          const p = lit ? clamp((t - word.start) / span, 0, 1) : t >= word.end ? 1 : 0
          word.el.style.setProperty('--p', p.toFixed(3))
          word.el.classList.toggle('is-singing', lit && p > 0 && p < 1)
        }
      }
      painted = activeSet.slice()
    }

    /* ---------- scrolling: a spring, with later lines trailing the first ---------- */

    let pos = 0
    let vel = 0
    let manual = 0
    let history: { at: number; pos: number }[] = []
    const scrolling = ref(false)
    let resumeTimer: ReturnType<typeof setTimeout> | undefined

    function maxPos() {
      return Math.max(0, trackHeight - viewportHeight)
    }

    function baseTarget() {
      return current >= 0 && tops[current] !== undefined ? tops[current] - settings.anchor * viewportHeight : 0
    }

    /** Keep the user's scroll inside the lyrics: the target may not leave 0..maxPos. */
    function clampManual(value: number) {
      const base = baseTarget()
      return clamp(value, -Math.max(0, base), Math.max(0, maxPos() - base))
    }

    function autoTarget() {
      return clamp(baseTarget() + manual, 0, maxPos())
    }

    function posAt(time: number): number {
      if (history.length === 0) return pos
      if (time <= history[0].at) return history[0].pos
      for (let i = history.length - 1; i > 0; i--) {
        if (history[i - 1].at <= time) {
          const a = history[i - 1]
          const b = history[i]
          const f = b.at === a.at ? 1 : (time - a.at) / (b.at - a.at)
          return a.pos + (b.pos - a.pos) * clamp(f, 0, 1)
        }
      }
      return pos
    }

    let wrote = false
    function step(dt: number, now: number): boolean {
      const target = autoTarget()
      const distance = target - pos
      if (reduced.value || settings.scroll === 'instant') {
        pos = target
        vel = 0
      } else if (settings.scroll === 'smooth') {
        pos += distance * (1 - Math.exp(-dt * 9))
        vel = 0
      } else {
        // Semi-implicit Euler, in a few small steps so a stiff spring stays stable.
        const sub = 3
        const h2 = dt / sub
        for (let n = 0; n < sub; n++) {
          vel += (settings.stiffness * (target - pos) - settings.damping * vel) * h2
          pos += vel * h2
        }
      }
      const resting = Math.abs(target - pos) < 0.25 && Math.abs(vel) < 2
      if (resting) {
        pos = target
        vel = 0
      }

      history.push({ at: now, pos })
      const cut = now - 1500
      while (history.length > 2 && history[1].at < cut) history.shift()

      const y = -pos
      if (track.value) track.value.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`

      // Lines further down lag by a fraction of a second behind the first.
      const stagger = reduced.value || settings.scroll !== 'spring' || scrolling.value ? 0 : settings.stagger
      const moving = !resting || history.some((sample) => Math.abs(sample.pos - pos) > 0.3)
      if (stagger > 0 && moving) {
        wrote = true
        for (let i = 0; i < rows.length; i++) {
          const rel = i - Math.max(current, 0)
          const lag = rel > 0 ? Math.min(rel, 10) * stagger : 0
          const extra = lag ? pos - posAt(now - lag) : 0
          rows[i].el.style.transform = Math.abs(extra) > 0.05 ? `translate3d(0, ${extra.toFixed(2)}px, 0)` : ''
        }
      } else if (wrote) {
        wrote = false
        for (const row of rows) row.el.style.transform = ''
      }
      return !resting || moving
    }

    /* ---------- the loop ---------- */

    let raf = 0
    let last = 0
    let lastT = NaN
    let running = false

    function visible() {
      if (!viewport.value) return false
      if (!full.value && (view.fullscreen || !ui.playerExpanded.value)) return false
      return !document.hidden
    }

    function frame(now: number) {
      raf = 0
      running = false
      if (!visible() || plain.value || rows.length === 0) return
      const dt = last ? Math.min((now - last) / 1000, 0.034) : 0.016
      last = now
      const t = timeNow(now)
      applyStates(t)
      if (settings.wordFill || settings.lineFill) paint(t)
      paintDots(t)
      const animating = step(dt, now)
      const advancing = player.isPlaying.value || t !== lastT
      lastT = t
      if (animating || advancing) schedule()
      else last = 0
    }

    function paintDots(t: number) {
      for (const i of activeSet) {
        const item = items.value[i]
        if (item?.kind !== 'dots') continue
        const dots = rows[i]?.el.querySelectorAll<HTMLElement>('.lyr-dot')
        if (!dots) continue
        const p = clamp((t - item.start) / Math.max(item.end - item.start, 0.1), 0, 1)
        dots.forEach((dot, k) => dot.style.setProperty('--o', String(0.28 + 0.72 * clamp(p * 3 - k, 0, 1))))
      }
    }

    function schedule() {
      if (running) return
      running = true
      raf = requestAnimationFrame(frame)
    }

    function wake() {
      last = 0
      schedule()
    }

    /* ---------- the user ---------- */

    function holdManual() {
      scrolling.value = true
      clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => {
        manual = 0
        scrolling.value = false
        wake()
      }, settings.resumeDelay * 1000)
      wake()
    }

    function onWheel(event: WheelEvent) {
      if (!full.value || plain.value) return
      event.preventDefault()
      manual = clampManual(manual + event.deltaY)
      holdManual()
    }

    let down: { x: number; y: number; at: number; lastY: number; lastAt: number; speed: number; moved: boolean } | null = null

    function onPointerDown(event: PointerEvent) {
      if (!full.value || plain.value) return
      down = { x: event.clientX, y: event.clientY, at: performance.now(), lastY: event.clientY, lastAt: performance.now(), speed: 0, moved: false }
      viewport.value?.setPointerCapture(event.pointerId)
    }

    function onPointerMove(event: PointerEvent) {
      if (!down) return
      if (Math.abs(event.clientY - down.y) > 6) down.moved = true
      if (!down.moved) return
      const now = performance.now()
      const dy = event.clientY - down.lastY
      manual = clampManual(manual - dy)
      down.speed = dy / Math.max(1, now - down.lastAt)
      down.lastY = event.clientY
      down.lastAt = now
      holdManual()
    }

    function onPointerUp(event: PointerEvent) {
      if (!down) return
      const gesture = down
      down = null
      if (gesture.moved) {
        // A flick keeps going a little.
        manual = clampManual(manual - gesture.speed * 220)
        holdManual()
        return
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-i]')
      const item = target ? items.value[Number(target.dataset.i)] : undefined
      if (item && item.start >= 0) {
        manual = 0
        scrolling.value = false
        clearTimeout(resumeTimer)
        player.seek(Math.max(0, item.start - (view.offset + settings.lead) / 1000))
        wake()
      }
    }

    /* ---------- lifecycle ---------- */

    let observer: ResizeObserver | undefined
    onMounted(() => {
      observer = new ResizeObserver(() => {
        measure()
        wake()
      })
      if (viewport.value) observer.observe(viewport.value)
      if (track.value) observer.observe(track.value)
      void nextTick(collect)
      document.addEventListener('visibilitychange', wake)
    })
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
      clearTimeout(resumeTimer)
      document.removeEventListener('visibilitychange', wake)
    })

    watch(items, () => void nextTick(collect), { flush: 'post' })
    watch([translations, romanizations], () => void nextTick(collect))
    watch(
      () => [settings.wordFill, settings.lineFill, settings.textSize, settings.align, settings.anchor, settings.fontWeight, settings.subLineScale],
      () => void nextTick(collect),
    )
    watch(() => [player.isPlaying.value, player.position.value, view.offset, ui.playerExpanded.value, view.fullscreen], wake)
    watch(() => view.songKey, () => {
      pos = 0
      vel = 0
      manual = 0
      history = []
      current = -1
    })

    /* ---------- drawing ---------- */

    function sub(text: string | null | undefined, kind: 'roman' | 'trans') {
      return text ? h('span', { class: ['lyr-sub', kind === 'roman' ? 'lyr-roman' : 'lyr-trans'] }, text) : null
    }

    function renderItem(item: Item, index: number) {
      const classes = ['lyr-line']
      const attrs: Record<string, unknown> = { 'data-i': index, key: item.key }
      if (item.kind === 'dots') {
        classes.push('lyr-dots')
        return h('div', { ...attrs, class: classes }, [
          h('div', { class: 'lyr-body' }, [h('div', { class: 'lyr-dots-body' }, [h('span', { class: 'lyr-dot' }), h('span', { class: 'lyr-dot' }), h('span', { class: 'lyr-dot' })])]),
        ])
      }

      const { line } = item
      if (item.kind === 'bg') classes.push('is-bg')
      if (line.agent === 'right') classes.push('is-right')
      if (!plain.value && full.value) classes.push('is-seekable')

      let main: unknown
      if (plain.value || (!settings.wordFill && !settings.lineFill)) {
        main = h('span', { class: 'lyr-text' }, line.text || ' ')
      } else if (line.words?.length && settings.wordFill) {
        main = h('span', { class: 'lyr-text' }, groupWords(line, (_, text) => h('span', { class: 'lyr-word' }, text)) as never)
      } else if (settings.lineFill) {
        main = h('span', { class: 'lyr-text' }, [h('span', { class: 'lyr-word' }, line.text)])
      } else {
        main = h('span', { class: 'lyr-text' }, line.text)
      }

      const roman = item.src >= 0 ? romanizations.value[item.src] : null
      const trans = item.src >= 0 ? translations.value[item.src] : null
      return h('div', { ...attrs, class: classes }, [
        h('div', { class: 'lyr-body' }, [main as never, settings.romanize ? sub(roman, 'roman') : null, settings.translate ? sub(trans, 'trans') : null]),
      ])
    }

    function message(text: string, spinner = false) {
      return h('div', { class: 'lyr-message' }, [spinner ? h('div', { class: 'lyr-spinner' }) : null, h('span', text)])
    }

    return () => {
      const song = player.currentSong.value
      const lyrics = view.lyrics
      const style: Record<string, string> = {
        '--lyr-weight': String(settings.fontWeight),
        '--lyr-align': settings.align,
        '--lyr-origin': settings.align === 'left' ? 'left center' : settings.align === 'right' ? 'right center' : 'center',
        '--lyr-inactive-opacity': String(settings.inactiveOpacity),
        '--lyr-inactive-scale': settings.focus ? String(settings.inactiveScale) : '1',
        '--lyr-blur-step': `${settings.blur / 3}px`,
        '--lyr-lift': String(settings.wordLift),
        '--lyr-glow': String(settings.glow),
        '--lyr-stagger': `${reduced.value ? 0 : settings.stagger}ms`,
        '--lyr-sub-scale': String(settings.subLineScale),
        fontSize: `${settings.textSize * 100}%`,
      }
      const hue = player.currentHue.value

      const background = h('div', { class: 'lyr-bg', 'aria-hidden': 'true' }, [
        settings.background === 'artwork' && song
          ? h('div', { class: ['lyr-bg-art', settings.backgroundMotion && !reduced.value ? 'is-moving' : ''] }, [
              h(Noctis.C.Thumb, { src: song.thumbnail, size: 160, eager: true, shape: 'square' }),
            ])
          : settings.background === 'gradient'
            ? h('div', {
                style: {
                  position: 'absolute',
                  inset: '0',
                  background: `linear-gradient(160deg, hsl(${hue ?? 260} 55% 30%), hsl(${((hue ?? 260) + 55) % 360} 60% 14%))`,
                },
              })
            : null,
      ])

      let body: unknown
      if (!lyrics) {
        body =
          view.status === 'loading' || view.status === 'idle'
            ? message('Looking for lyrics…', true)
            : message(view.status === 'error' ? view.error : 'No lyrics found')
      } else if (lyrics.instrumental) {
        body = message('♪  Instrumental')
      } else {
        body = h(
          'div',
          {
            ref: viewport,
            class: ['lyr-viewport', plain.value ? 'is-plain' : ''],
            onWheel,
            onPointerdown: onPointerDown,
            onPointermove: onPointerMove,
            onPointerup: onPointerUp,
            onPointercancel: () => (down = null),
          },
          [
            h('div', { ref: track, class: 'lyr-track' }, [
              h('div', { class: 'lyr-spacer-top' }),
              ...items.value.map(renderItem),
              h('div', { class: 'lyr-spacer' }),
            ]),
          ],
        )
      }

      return h(
        'div',
        {
          class: [
            'lyr-pane',
            `lyr-${props.mode}`,
            settings.background === 'plain' ? 'lyr-plain-bg' : '',
            settings.focus ? '' : 'lyr-no-focus',
            settings.blur > 0 ? '' : 'lyr-no-blur',
            scrolling.value ? 'lyr-scrolling' : '',
            reduced.value ? 'lyr-reduced' : '',
          ],
          style,
          onClick: () => {
            if (!full.value) emit('tap')
          },
        },
        [background, body as never],
      )
    }
  },
})

