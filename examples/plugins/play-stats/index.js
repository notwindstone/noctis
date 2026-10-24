/*
 * Server charts: the client half (see docs/SERVER-PLUGINS.md).
 *
 * Reports each song that starts playing to the connected Noctis server, and adds
 * Settings → Server charts with the server's most played songs. The server half
 * (server.js) requires this half, so a client without it can't use the server.
 */

const { Plugin, Noctis } = scopedThis
const { shallowReactive } = Noctis.packages.vue
const { server, player, snackbar } = Noctis.libs
const { group } = Noctis

const BASE = '/api/plugins/play-stats'

/** What the server stores about a song: enough to show and play it. */
function summary(song) {
  return {
    id: song.id,
    title: song.title,
    artists: (song.artists ?? []).slice(0, 20).map((artist) => ({ name: artist.name, ...(artist.id ? { id: artist.id } : {}) })),
    ...(song.source ? { source: song.source } : {}),
    ...(song.thumbnail ? { thumbnail: song.thumbnail } : {}),
  }
}

async function report({ song }) {
  if (!server.serverUrl.value || !song) return
  try {
    await server.serverRequest(`${BASE}/plays`, { method: 'POST', body: { song: summary(song) } })
  } catch (error) {
    Plugin.warn(`Couldn't report a play: ${error.message}`)
  }
}

const chartRows = shallowReactive([])

async function refresh() {
  if (!server.serverUrl.value) {
    snackbar.notify('Connect to a Noctis server first (Settings → Server)')
    return
  }
  try {
    const top = await server.serverRequest(`${BASE}/top`)
    chartRows.splice(
      0,
      chartRows.length,
      ...top.map((entry, index) => ({
        id: `${entry.song.source ?? ''}:${entry.song.id}`,
        icon: 'music',
        title: `${index + 1}. ${entry.song.title}`,
        description: `${entry.song.artists.map((artist) => artist.name).join(', ')} · ${entry.plays} ${entry.plays === 1 ? 'play' : 'plays'}`,
        onClick: () => void player.playSong(entry.song),
      })),
    )
  } catch (error) {
    snackbar.notify(error.message)
  }
}

const SECTION = { id: 'play-stats', icon: 'equalizer', title: 'Server charts', description: 'Most played on your Noctis server' }

function attach() {
  Plugin.subscribe('hook::onPlay::after', report)
  Plugin.defineSection(SECTION, [
    group('actions', [{ id: 'refresh', icon: 'refresh', title: 'Refresh charts', onClick: refresh }]),
    group('chart', chartRows),
    { id: 'note', type: 'note', text: 'Everyone on the server with this plugin reports what they play; the counts are shared.' },
  ])
  if (server.serverUrl.value) void refresh()
}

function detach() {
  Plugin.unsubscribe('hook::onPlay::after', report)
  Plugin.removeSection(SECTION.id)
}

Plugin.subscribe('lifecycle::disable', detach)
Plugin.subscribe('lifecycle::dirty-enable', attach)
attach()
