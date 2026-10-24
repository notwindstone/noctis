import { watch, type Component, type WatchStopHandle } from 'vue'
import { registerAction, unregisterAction, type ActionFunction } from './actions'
import { registerComponent, restoreComponent } from './components'
import { PluginBase, type PluginCallback } from '@noctis/plugin-core'
import { hookRegistry, type HookName } from './hooks'
import { writeLog } from './log'
import { defineSection, removeSection, type SettingsBlock, type SettingsSection } from './rows'
import { defineService, removeService } from '../services/registry'
import type { ServiceDefinition } from '../services/types'

/**
 * What a plugin gets as `scopedThis.Plugin`. Lifecycle, hook events and logging come
 * from @noctis/plugin-core's PluginBase (shared with server plugins); this adds the
 * client's registries and one more kind of event:
 *
 *   () => state    a getter: the callback runs when its value changes
 *
 * Everything registered through it is attributed to the plugin, so conflicts and
 * errors name it.
 */
export class PluginAPI extends PluginBase<HookName> {
  private watchers = new Map<() => unknown, Map<PluginCallback, WatchStopHandle>>()

  constructor(id: string) {
    super(id, hookRegistry, writeLog)
  }

  protected override subscribeOther(event: unknown, callback: PluginCallback): boolean {
    if (typeof event !== 'function') return false
    const watcher = event as () => unknown
    const byCallback = this.watchers.get(watcher) ?? new Map<PluginCallback, WatchStopHandle>()
    this.watchers.set(watcher, byCallback)
    byCallback.get(callback)?.()
    byCallback.set(callback, watch(watcher, (value) => callback(value)))
    return true
  }

  protected override unsubscribeOther(event: unknown, callback: PluginCallback): boolean {
    if (typeof event !== 'function') return false
    const watcher = event as () => unknown
    this.watchers.get(watcher)?.get(callback)?.()
    this.watchers.get(watcher)?.delete(callback)
    return true
  }

  /* Registries, attributed to this plugin */
  registerComponent(name: string, component: Component) {
    registerComponent(name, component, this.id)
  }

  restoreComponent(name: string) {
    return restoreComponent(name)
  }

  registerAction<Props>(id: string, action: ActionFunction<Props>) {
    registerAction(id, action, this.id)
  }

  unregisterAction(id: string) {
    unregisterAction(id)
  }

  defineSection(section: SettingsSection, blocks: SettingsBlock[], position?: number) {
    defineSection(section, blocks, this.id, position)
  }

  removeSection(id: string) {
    removeSection(id)
  }

  /** Add a streaming service (see src/services/types.ts); items it returns carry `source: id`. */
  defineService(id: string, definition: ServiceDefinition) {
    defineService(id, definition, this.id)
  }

  removeService(id: string) {
    removeService(id)
  }

  /** Small per-plugin key/value storage (JSON values), kept on the device. */
  readonly storage = {
    get: <T>(key: string, fallback?: T): T | undefined => {
      try {
        const raw = localStorage.getItem(`noctis:plugin-data:${this.id}:${key}`)
        return raw === null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    set: (key: string, value: unknown) => {
      try {
        localStorage.setItem(`noctis:plugin-data:${this.id}:${key}`, JSON.stringify(value))
      } catch (error) {
        writeLog(this.id, 'error', `Couldn't store "${key}":`, error)
      }
    },
    remove: (key: string) => {
      try {
        localStorage.removeItem(`noctis:plugin-data:${this.id}:${key}`)
      } catch {
        /* nothing to remove */
      }
    },
  }
}
