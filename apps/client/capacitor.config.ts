import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.noctis.player',
  appName: 'Noctis',
  webDir: 'dist',
  backgroundColor: '#111318',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    App: {
      // Back is owned by the Noctis plugin so predictive back can be driven from the web
      // layer. Leaving the App plugin's handler on would swallow every gesture.
      disableBackButtonHandler: true,
    },
    SystemBars: {
      insetsHandling: 'css',
    },
  },
}

export default config
