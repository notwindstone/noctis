import { attachFile, choose, detachFile, load, setOffset, songKeyOf } from './engine'
import { Noctis } from './host'
import { settings, view } from './state'
import { LyricsPane } from './view'
import { kv } from './util'
import { localKey } from './sources/local'

const { Transition, defineComponent, h } = Noctis.packages.vue
const { player, ui, snackbar } = Noctis.libs

const icon = (name: string, size = 22, filled = false) => h(Noctis.C.MIcon, { name, size, filled })

export function openFullscreen() {
  if (!player.currentSong.value) return
  view.fullscreen = true
}

export function closeFullscreen() {
  view.fullscreen = false
}

/* ------------------------------------------------------------------ *
 * Options menu
 * ------------------------------------------------------------------ */

function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = async () => {
      const file = input.files?.[0]
      resolve(file ? { name: file.name, text: await file.text() } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

const syncLabel = { word: 'word by word', line: 'line by line', none: 'no timing' } as const

function chooseSource() {
  const options = view.candidates.map((lyrics) => ({
    value: lyrics.source,
    label: lyrics.sourceName,
    description: lyrics.instrumental ? 'Instrumental' : `${syncLabel[lyrics.sync]}, ${lyrics.lines.length} lines`,
  }))
  const failed = Object.entries(view.failures)
  if (options.length === 0) {
    snackbar.notify(failed.length ? `No source had lyrics. ${failed.map(([id, why]) => `${id}: ${why}`).join('; ')}` : 'No source had lyrics for this song')
    return
  }
  ui.showChoice({
    title: 'Lyrics source',
    options,
    value: view.lyrics?.source ?? '',
    onSelect: (value: string) => choose(value),
  })
}

export function openMenu() {
  const song = player.currentSong.value
  if (!song) return
  const offsetLabel = `${view.offset >= 0 ? '+' : ''}${(view.offset / 1000).toFixed(2)} s`
  ui.showChoice({
    title: 'Lyrics',
    value: '',
    options: [
      { value: 'source', label: 'Choose source', description: view.lyrics ? `Now: ${view.lyrics.sourceName}` : 'None found' },
      { value: 'earlier', label: 'Show lyrics earlier', description: `Timing ${offsetLabel} — each tap moves 0.25 s` },
      { value: 'later', label: 'Show lyrics later', description: `Timing ${offsetLabel}` },
      { value: 'reset', label: 'Reset timing' },
      { value: 'file', label: 'Use a lyrics file…', description: '.lrc, .ttml (word by word), .srt or .txt' },
      { value: 'remove', label: 'Stop using my file' },
      { value: 'refresh', label: 'Search again' },
      { value: 'cover', label: view.showCover ? 'Show lyrics in place of the cover' : 'Show the cover for this song' },
      { value: 'settings', label: 'Lyrics settings' },
    ],
    onSelect: async (value: string) => {
      switch (value) {
        case 'source':
          chooseSource()
          break
        case 'earlier':
        case 'later':
          setOffset(view.offset + (value === 'later' ? 250 : -250))
          setTimeout(openMenu, 0)
          break
        case 'reset':
          setOffset(0)
          break
        case 'file': {
          const file = await pickFile('.lrc,.ttml,.xml,.srt,.txt,text/plain')
          if (!file) return
          try {
            await attachFile(song, file.name, file.text)
            snackbar.notify(`Using ${file.name}`)
          } catch (error) {
            snackbar.notify(error instanceof Error ? error.message : String(error))
          }
          break
        }
        case 'remove':
          if (await kv.get(localKey(songKeyOf(song)))) await detachFile(song)
          else snackbar.notify('No file is attached to this song')
          break
        case 'refresh':
          void load(song, true)
          break
        case 'cover':
          view.showCover = !view.showCover
          break
        case 'settings':
          closeFullscreen()
          ui.closePlayer()
          void Noctis.libs.navigation.navigate({ name: 'settings-page', page: 'lyrics' })
          break
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * The full-screen overlay
 * ------------------------------------------------------------------ */

function button(name: string, label: string, onClick: () => void, extra: { active?: boolean; size?: number; filled?: boolean; class?: string } = {}) {
  return h(
    'button',
    { class: ['lyr-icon-button', extra.active ? 'is-active' : '', extra.class ?? ''], type: 'button', 'aria-label': label, 'aria-pressed': extra.active, onClick },
    [icon(name, extra.size ?? 22, extra.filled)],
  )
}

function chip(name: string, label: string, active: boolean, onClick: () => void, error = false) {
  return h('button', { class: ['lyr-chip', active ? 'is-active' : '', error ? 'is-error' : ''], type: 'button', 'aria-pressed': active, onClick }, [icon(name, 18), h('span', { class: 'lyr-chip-label' }, label)])
}

function statusLine(): string {
  const parts: string[] = []
  if (settings.translate && view.translation === 'working') parts.push('Translating…')
  if (settings.translate && view.translation === 'error') parts.push(`Translation: ${view.translationError}`)
  if (settings.romanize && view.romanization === 'working') parts.push('Romanizing…')
  if (settings.romanize && view.romanizationError) parts.push(`Romanization: ${view.romanizationError}`)
  return parts.join('\n')
}

export const Overlay = defineComponent({
  name: 'LyricsOverlay',
  setup() {
    return () =>
      h(Transition, { name: 'lyr-fade' }, () => {
        const song = player.currentSong.value
        if (!view.fullscreen || !song) return null
        const status = statusLine()
        const lyrics = view.lyrics
        return h('div', { class: 'lyr-overlay', role: 'dialog', 'aria-label': 'Lyrics' }, [
          h(LyricsPane, { mode: 'full' }),
          h('div', { class: 'lyr-top' }, [
            button('collapse', 'Close lyrics', closeFullscreen),
            h('div', { class: 'lyr-titles' }, [h('strong', song.title), h('span', song.artists.map((artist) => artist.name).join(', '))]),
            lyrics && !lyrics.instrumental ? chip('translate', 'Translate', settings.translate, () => (settings.translate = !settings.translate), view.translation === 'error') : null,
            lyrics && !lyrics.instrumental ? chip('language', 'Romanize', settings.romanize, () => (settings.romanize = !settings.romanize), view.romanization === 'error') : null,
            button('more', 'Lyrics options', openMenu),
          ]),
          status ? h('div', { class: 'lyr-status', style: { whiteSpace: 'pre-line' } }, status) : null,
          h('div', { class: 'lyr-bottom' }, [
            h(Noctis.C.SeekBar, { position: player.position.value, duration: player.duration.value, onSeek: (seconds: number) => player.seek(seconds) }),
            h('div', { class: 'lyr-controls' }, [
              button('previous', 'Previous', () => player.previous(), { size: 30, filled: true }),
              button(player.isPlaying.value ? 'pause' : 'play', player.isPlaying.value ? 'Pause' : 'Play', () => void player.togglePlay(), { size: 34, filled: true, class: 'lyr-play' }),
              button('next', 'Next', () => player.next(), { size: 30, filled: true }),
            ]),
          ]),
        ])
      })
  },
})

/* ------------------------------------------------------------------ *
 * The cover's replacement in the full player
 * ------------------------------------------------------------------ */

export const PlayerArt = defineComponent({
  name: 'LyricsPlayerArt',
  props: { song: { type: Object, required: true } },
  setup(props) {
    return () => {
      const song = props.song as { thumbnail?: string }
      const thumb = () => h(Noctis.C.Thumb, { src: song.thumbnail, size: 560, shape: 'rounded', eager: true })
      if (!settings.enabled || !settings.replaceCover) return thumb()

      const found = view.lyrics && (view.lyrics.lines.length > 0 || view.lyrics.instrumental)
      const corner = (children: unknown[]) => h('div', { class: 'lyr-corner' }, children as never)

      if (!found || view.showCover) {
        if (!found && !view.showCover && !settings.coverFallback && view.status !== 'loading') return h('div', { class: 'lyr-cover-wrap' }, [h(LyricsPane, { mode: 'inline' })])
        return h('div', { class: 'lyr-cover-wrap' }, [
          thumb(),
          found ? corner([button('lyrics', 'Show lyrics', () => (view.showCover = false))]) : view.status === 'loading' ? corner([h('div', { class: 'lyr-spinner', style: { margin: '8px' } })]) : null,
        ])
      }

      return h('div', { class: 'lyr-cover-wrap' }, [
        h(LyricsPane, { mode: 'inline', onTap: () => (settings.tapToExpand ? openFullscreen() : undefined) }),
        corner([
          button('image', 'Show the cover', (event?: unknown) => {
            ;(event as Event | undefined)?.stopPropagation?.()
            view.showCover = true
          }),
          button('lyr-expand', 'Open lyrics full screen', openFullscreen),
        ]),
      ])
    }
  },
})
