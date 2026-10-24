import * as Capacitor from '@capacitor/core'
import * as Vue from 'vue'
import * as auth from '../auth'
import * as back from '../back'
import * as haptics from '../haptics'
import { registerIcon, ICONS } from '../icons'
import * as library from '../library'
import * as native from '../native'
import * as navigation from '../navigation'
import * as offline from '../offline'
import * as player from '../player'
import * as server from '../server'
import * as preferences from '../preferences'
import * as snackbar from '../snackbar'
import * as storage from '../storage'
import * as theme from '../theme'
import * as ui from '../ui'
import * as http from '../http'
import * as models from '../models'
import * as api from '../services/api'
import { activeService, activeServiceId, defineService, removeService, services } from '../services/registry'
import * as session from '../services/session'
import * as stream from '../services/stream'
import * as thumbnails from '../thumbnails'
import {
  ActionCollections,
  Actions,
  defineCollection,
  executeAction,
  registerAction,
  resolveEntry,
  unregisterAction,
  visibleEntries,
} from './actions'
import { C, registerComponent, restoreComponent } from './components'
import { HOOK_NAMES, hooks, withHooks } from './hooks'
import { pluginLog, writeLog } from './log'
import { PluginAPI } from './plugin-api'
import { defineSection, group, removeSection, Rows, Sections } from './rows'

/**
 * `window.__NOCTIS__`: everything plugins can reach. Unrestricted plugins can of course
 * import nothing and touch anything; this is the supported, documented surface.
 */
function build() {
  return {
    version: '0.2.0',
    /**
     * The app's own Vue (so plugin components share its reactivity) and Capacitor (so
     * native plugins like CapacitorHttp are the app's instances).
     */
    packages: { vue: Vue, capacitor: Capacitor },

    /* Component registry */
    C,
    registerComponent,
    restoreComponent,

    /* Actions and action collections */
    Actions,
    ActionCollections,
    registerAction,
    unregisterAction,
    executeAction,
    defineCollection,
    resolveEntry,
    visibleEntries,

    /* Settings rows */
    Rows,
    Sections,
    defineSection,
    removeSection,
    group,

    /* Services: streaming backends, each defined by a plugin */
    services,
    defineService,
    removeService,
    activeService,
    activeServiceId,
    /** request(service, "albums.get", { id }) etc.; plus helpers screens use. */
    api,

    /* Hooks */
    hooks,
    hookNames: HOOK_NAMES,
    withHooks,

    /* Icons */
    icons: ICONS,
    registerIcon,

    /* Logging */
    log: pluginLog,
    writeLog,

    /* The app */
    libs: {
      auth,
      back,
      haptics,
      http,
      library,
      models,
      native,
      navigation,
      offline,
      player,
      preferences,
      server,
      session,
      snackbar,
      storage,
      stream,
      theme,
      thumbnails,
      ui,
    },

    PluginAPI,
  }
}

export type NoctisNamespace = ReturnType<typeof build>

declare global {
  interface Window {
    __NOCTIS__: NoctisNamespace
  }
}

let namespace: NoctisNamespace | null = null

export function noctisNamespace(): NoctisNamespace {
  namespace ??= build()
  return namespace
}

export function exposeNamespace() {
  window.__NOCTIS__ = noctisNamespace()
}
