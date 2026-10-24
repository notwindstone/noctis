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
import { initTheme } from './theme'

initTheme()
initPlayer()
initMediaControls()

// Built-in actions, menus and settings use the same registries plugins extend.
defineBuiltIns()
defineBuiltInSettings()
definePluginSettings()
exposeNamespace()

createApp(App).mount('#app')

// Like Kaede's extension loader: plugins start once the app is on screen.
void startPlugins()
