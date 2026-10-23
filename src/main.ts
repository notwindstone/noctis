import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'
import { initMediaControls } from './mediaControls'
import { initPlayer } from './player'
import { initTheme } from './theme'

initTheme()
initPlayer()
initMediaControls()

createApp(App).mount('#app')
