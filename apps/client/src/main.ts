import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'
import { initMediaControls } from './mediaControls'
import { initPlayer } from './player'
import { defineBuiltIns } from './plugins/builtins'
import { exposeNamespace } from './plugins/namespace'
import { startPlugins } from './plugins/runtime'
import { defineBuiltInSettings } from './settings/builtin'
import { definePluginSettings } from './settings/plugins'
import { defineServerSettings } from './settings/server'
import { defineLocalSettings } from './settings/local'
import { defineAccountSettings } from './settings/accounts'
import { initDeviceService } from './local/service'
import { isNative } from './native'
import { initOpenFiles } from './openFiles'
import { connect, serverUrl } from './server'
import { canUseServer } from './subsonic/client'
import { attachServerService } from './subsonic/service'
import { initTheme } from './theme'

initTheme()
initPlayer()
initMediaControls()

// Built-in actions, menus and settings use the same registries plugins extend.
defineBuiltIns()
defineBuiltInSettings()
definePluginSettings()
defineServerSettings()
defineLocalSettings()
defineAccountSettings()
exposeNamespace()

initDeviceService()

// Signed in to a server (or a guest on one): it's a service from the start, so Home doesn't wait for the network.
if (serverUrl.value && canUseServer()) attachServerService()

createApp(App).mount('#app')

// Like Kaede's extension loader: plugins start once the app is on screen. Then check in
// with the server, so it sees which plugins are running.
// Served by a Noctis server (its web client at "/"): connect to that server right away.
const hostedBy = !isNative && document.querySelector('meta[name="noctis-server"]')?.getAttribute('content') === 'same-origin' ? location.origin : null

// Opened files (a .noctis plugin) wait for plugins, so installing one can replace a running one.
void startPlugins().then(() => {
  initOpenFiles()
  if (!serverUrl.value && hostedBy) void connect(hostedBy).catch(() => {})
  else if (serverUrl.value) void connect().catch(() => {})
})
