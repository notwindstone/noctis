/*
 * Demo source — an example Noctis plugin (see docs/PLUGINS.md).
 *
 * This file is the body of an async function. It receives `scopedThis` with:
 *   scopedThis.Plugin  — this plugin's API (services, hooks, lifecycle, registries, log, storage)
 *   scopedThis.Noctis  — window.__NOCTIS__ (registries, app libraries, Vue)
 *
 * It shows every extension surface:
 *   1. a streaming service ("demo"): home, search, albums, queues and streams of generated tones
 *   2. the onRequest hook: "demo …" searches go to the demo service whichever one is active
 *   3. an action + an action-collection entry (song menu)
 *   4. a settings section built from getter-based rows
 *   5. the component registry (a new screen)
 *   6. the lifecycle: undo everything on disable, redo it on dirty-enable
 */

const { Plugin, Noctis } = scopedThis
const { h, ref } = Noctis.packages.vue
const SOURCE = 'demo'

/* ------------------------------------------------------------------ *
 * 1. A tiny "streaming service": songs that are generated tones
 * ------------------------------------------------------------------ */

const NOTES = [
  ['C', 261.63],
  ['D', 293.66],
  ['E', 329.63],
  ['F', 349.23],
  ['G', 392.0],
  ['A', 440.0],
  ['B', 493.88],
]

const album = { type: 'album', source: SOURCE, id: 'demo:album:scale', title: 'The Demo Scale', artists: [{ name: 'Demo Orchestra' }], year: '2026', kind: 'Album' }

const songs = NOTES.map(([note, frequency], index) => ({
  type: 'song',
  source: SOURCE,
  id: `demo:${note}`,
  title: `${note} (${frequency} Hz)`,
  artists: [{ name: 'Demo Orchestra' }],
  album: { id: album.id, name: album.title },
  duration: 8,
  frequency,
  index,
}))

/** A short sine tone as a WAV blob URL — playable by the app's <audio> element. */
function toneUrl(frequency, seconds = 8) {
  const rate = 22050
  const samples = rate * seconds
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 2000, (samples - i) / 2000)
    view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * frequency * i) / rate) * 9000 * fade, true)
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

const scaleSection = { id: 'demo-scale', title: 'The Demo Scale', layout: 'list', items: songs }

// Every endpoint takes one input object and returns a promise (plain values are fine
// from an async function). Leave out what a service can't do.
const demoService = {
  name: 'Demo',
  icon: 'equalizer',
  home: {
    async load() {
      return {
        sections: [{ id: 'demo-albums', title: 'Albums', layout: 'carousel', items: [album] }, scaleSection],
        filters: [],
        selectedFilter: null,
        hasMore: false,
      }
    },
  },
  search: {
    filters: [{ id: 'song', label: 'Songs' }],
    async query({ query, type }) {
      const needle = query.toLowerCase().replace(/^demo\s*/, '')
      const matches = songs.filter((song) => song.title.toLowerCase().includes(needle) || needle === '' || 'scale'.startsWith(needle))
      if (type === 'song') return { sections: [], items: matches, hasMore: false }
      return {
        sections: [
          { id: 'demo-album', title: 'Album', layout: 'list', items: [album] },
          { id: 'demo-songs', title: 'Songs', layout: 'list', items: matches },
        ],
        items: [],
        hasMore: false,
      }
    },
    async suggestions({ input }) {
      return { queries: ['demo scale', 'demo C', 'demo A'].filter((query) => query.startsWith(input.toLowerCase())), items: [] }
    },
  },
  albums: {
    async get({ id }) {
      if (id !== album.id) throw new Error('No such album')
      return { id, kind: 'album', title: album.title, subtitle: 'Album • 2026', artists: album.artists, year: album.year, songs, hasMore: false, sections: [] }
    },
  },
  queue: {
    // "Up next" for a demo song: the rest of the scale.
    async radio(seed) {
      const start = seed.kind === 'song' ? songs.findIndex((item) => item.id === seed.song.id) : 0
      return { songs: songs.slice(Math.max(0, start)) }
    },
  },
  streams: {
    async resolve({ song }) {
      const match = songs.find((item) => item.id === song.id)
      if (!match) throw new Error('Not a demo song')
      return { url: toneUrl(match.frequency), mimeType: 'audio/wav', bitrate: 352800, contentLength: 44 + 22050 * 8 * 2, expiresAt: Date.now() + 3600_000 }
    },
  },
}

/* ------------------------------------------------------------------ *
 * 2. The onRequest hook: route "demo …" searches here, whatever service is active
 * ------------------------------------------------------------------ */

const routeDemoSearches = (request) => {
  const { endpoint, input } = request
  if (endpoint === 'search.query' && /^demo\b/i.test(input.query)) {
    request.service = 'demo' // reroute: the app calls the demo service instead
    if (input.type !== 'all' && input.type !== 'song') input.type = 'all'
  }
}

/* ------------------------------------------------------------------ *
 * 3. A song-menu action
 * ------------------------------------------------------------------ */

Plugin.registerAction('demo.copyTitle', async ({ item, handlers }) => {
  await navigator.clipboard.writeText(item.title).catch(() => {})
  handlers.success(`Copied "${item.title}"`)
})

const copyEntry = { id: 'demo-copy-title', icon: 'share', label: 'Copy title (demo)', action: 'demo.copyTitle' }

/* ------------------------------------------------------------------ *
 * 4. Settings, as getter-based rows
 * ------------------------------------------------------------------ */

const loud = ref(Plugin.storage.get('loud', false))

function defineSettings() {
  Plugin.defineSection({ id: 'demo-source', icon: 'plugin', title: 'Demo source', description: 'Example plugin settings' }, [
    Noctis.group('main', [
      {
        id: 'loud',
        icon: 'equalizer',
        title: 'Log every play',
        description: 'Writes to this plugin\'s log whenever a song starts',
        toggle: {
          get value() {
            return loud.value
          },
          set(value) {
            loud.value = value
            Plugin.storage.set('loud', value)
          },
        },
      },
      {
        id: 'open-screen',
        icon: 'music',
        title: 'Open the demo screen',
        chevron: true,
        onClick: () => Noctis.libs.navigation.navigate({ name: 'DemoScreen' }),
      },
    ]),
    { id: 'note', type: 'note', text: 'Search for "demo scale", or switch to the Demo service in Settings → Content.' },
  ])
}

const onPlay = ({ song }) => {
  if (loud.value) Plugin.log(`Now playing: ${song.title}`)
}

/* ------------------------------------------------------------------ *
 * 5. A screen in the component registry
 * ------------------------------------------------------------------ */

const DemoScreen = {
  props: ['route', 'screenKey', 'isRoot'],
  setup() {
    const { C } = Noctis
    return () =>
      h('div', { class: 'screen' }, [
        h(C.TopAppBar, { title: 'Demo', back: true }),
        h('h1', { class: 'screen-headline type-headline-medium' }, 'Demo screen'),
        h('p', { class: 'settings-note type-body-medium muted' }, 'This screen comes from a plugin, rendered with the app\'s own Vue and components.'),
        h(
          'div',
          { class: 'section-list' },
          songs.map((song, index) => h(C.ItemRow, { item: song, index, key: song.id })),
        ),
      ])
  },
}

/* ------------------------------------------------------------------ *
 * 6. Lifecycle
 * ------------------------------------------------------------------ */

function attach() {
  Plugin.defineService(SOURCE, demoService)
  Plugin.subscribe('hook::onRequest::before', routeDemoSearches).subscribe('hook::onPlay::after', onPlay)
  Noctis.ActionCollections.songMenu.push(copyEntry)
  Plugin.registerComponent('DemoScreen', DemoScreen)
  defineSettings()
}

function detach() {
  Plugin.removeService(SOURCE)
  Plugin.unsubscribe('hook::onRequest::before', routeDemoSearches).unsubscribe('hook::onPlay::after', onPlay)
  const menu = Noctis.ActionCollections.songMenu
  const index = menu.indexOf(copyEntry)
  if (index !== -1) menu.splice(index, 1)
  Plugin.restoreComponent('DemoScreen')
  Plugin.removeSection('demo-source')
}

Plugin.subscribe('lifecycle::disable', detach)
Plugin.subscribe('lifecycle::dirty-enable', attach)

attach()
Plugin.log('Demo source is ready. Search for "demo scale", or pick "Demo" in Settings → Content → Service.')
