import { openUrl } from '@tauri-apps/plugin-opener'
import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'
import { initDragScroll } from './dragScroll'
import { initKeyboard } from './keyboard'
import { initTray } from './tray'
import { initMediaControls } from './mediaControls'
import { initPlayer } from './player'
import { defineBuiltIns } from './plugins/builtins'
import { exposeNamespace } from './plugins/namespace'
import { checkOnStart, collections, refreshAll, updates } from './plugins/collections'
import { startPlugins } from './plugins/runtime'
import { notify } from './snackbar'
import { defineBuiltInSettings } from './settings/builtin'
import { definePluginSettings } from './settings/plugins'
import { defineServerSettings } from './settings/server'
import { defineLocalSettings } from './settings/local'
import { defineAccountSettings } from './settings/accounts'
import { initDeviceService } from './local/service'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop, isNative } from './native'
import { initOpenFiles } from './openFiles'
import { connect, serverUrl } from './server'
import { canUseServer } from './subsonic/client'
import { attachServerService } from './subsonic/service'
import { initTheme } from './theme'

initTheme()
initPlayer()
initMediaControls()
initKeyboard()
initDragScroll()
initTray()

// Built-in actions, menus and settings use the same registries plugins extend.
defineBuiltIns()
defineBuiltInSettings()
definePluginSettings()
defineServerSettings()
defineLocalSettings()
defineAccountSettings()
exposeNamespace()

initDeviceService()

// A webview has nowhere to open a link to a website: send it to the system browser.
if (isDesktop) {
  document.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest?.('a[href]')
    if (!link || event.defaultPrevented) return
    const url = new URL((link as HTMLAnchorElement).href, location.href)
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return
    event.preventDefault()
    void openUrl(url.href)
  })
}

/*
 * The webview's own menu (Back, Refresh, Save as, Print…) means nothing in an app: a right
 * click is either the app's menu (songs, albums, the player: they handle it) or nothing.
 * Text fields and selected text keep theirs for copy and paste, and Shift + right click
 * still opens it anywhere (Inspect, while developing).
 */
document.addEventListener('contextmenu', (event) => {
  if (event.defaultPrevented || event.shiftKey) return
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return
  if (!(window.getSelection()?.isCollapsed ?? true)) return
  event.preventDefault()
})

// Signed in to a server (or a guest on one): it's a service from the start, so Home doesn't wait for the network.
if (serverUrl.value && canUseServer()) attachServerService()

createApp(App).mount('#app')

// Like Kaede's extension loader: plugins start once the app is on screen. Then check in
// with the server, so it sees which plugins are running.
// Served by a Noctis server (its web client at "/"): connect to that server right away.
const hostedBy = !isNative && document.querySelector('meta[name="noctis-server"]')?.getAttribute('content') === 'same-origin' ? location.origin : null

// Opened files (a .noctis plugin) wait for plugins, so installing one can replace a running one.
// `--no-plugins` (desktop) or `?no-plugins` (browser): for testing, and for getting in when a plugin breaks the app.
const noPlugins = isDesktop
  ? invoke<{ noPlugins: boolean }>('launch_options').then((options) => options.noPlugins, () => false)
  : Promise.resolve(new URLSearchParams(location.search).has('no-plugins'))

void noPlugins.then((skip) => startPlugins({ skip })).then(() => {
  initOpenFiles()
  // Say so when a plugin collection has something newer; updating is a tap in Settings → Plugins → Collections.
  if (checkOnStart.value && collections.value.length > 0) {
    void refreshAll().then(() => {
      const count = updates.value.length
      if (count > 0) notify(`${count} plugin ${count === 1 ? 'update' : 'updates'} available (Settings → Plugins → Collections)`, 6000)
    })
  }
  if (!serverUrl.value && hostedBy) void connect(hostedBy).catch(() => {})
  else if (serverUrl.value) void connect().catch(() => {})
})
