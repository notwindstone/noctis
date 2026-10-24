import { watch, type Component, type WatchStopHandle } from 'vue'
import { registerAction, unregisterAction, type ActionFunction } from './actions'
import { registerComponent, restoreComponent } from './components'
import { hooks, isHookName, type HookFunction, type HookName } from './hooks'
import { writeLog } from './log'
import { defineSection, removeSection, type SettingsBlock, type SettingsSection } from './rows'
import { defineService, removeService } from '../services/registry'
import type { ServiceDefinition } from '../services/types'

type Callback = (data: unknown) => unknown

type ParsedEvent =
  | { kind: 'state'; watcher: () => unknown }
  | { kind: 'lifecycle'; id: 'dirty-enable' }
  | { kind: 'lifecycle'; id: 'disable'; timing: 'before' | 'after' }
  | { kind: 'hook'; id: HookName; timing: 'before' | 'after'; position: 'start' | 'end' }

/**
 * Event names, as in Kaede:
 *   "hook::<name>::<before|after>[::start|end]"   (start = run before other plugins' hooks)
 *   "lifecycle::dirty-enable"                      (re-enabled without re-running the code)
 *   "lifecycle::disable[::before|after]"
 *   () => state                                    (a getter: runs the callback when it changes)
 */
function parseEvent(event: unknown): ParsedEvent {
  if (typeof event === 'function') return { kind: 'state', watcher: event as () => unknown }
  if (typeof event !== 'string') throw new TypeError('Events must be a function or a string')

  const [base, id, timing, position] = event.split('::')
  if (base === 'lifecycle') {
    if (id === 'dirty-enable') return { kind: 'lifecycle', id }
    if (id === 'disable') return { kind: 'lifecycle', id, timing: timing === 'after' ? 'after' : 'before' }
    throw new TypeError(`Unknown lifecycle event "${event}"`)
  }
  if (base === 'hook') {
    if (!id || !isHookName(id)) throw new TypeError(`Unknown hook "${id}"`)
    if (timing !== 'before' && timing !== 'after') throw new TypeError(`Hook timing must be "before" or "after"`)
    return { kind: 'hook', id, timing, position: position === 'start' ? 'start' : 'end' }
  }
  throw new TypeError(`Unknown event "${event}"`)
}

/**
 * What a plugin gets as `scopedThis.Plugin`. Everything registered through it is
 * attributed to the plugin, so conflicts and errors name it.
 *
 * Disabling a plugin only runs its `lifecycle::disable` callbacks; restoring components,
 * unregistering actions and removing hooks is up to the plugin (as in Kaede).
 */
export class PluginAPI {
  readonly id: string

  private lifecycle: Record<'dirtyEnable' | 'disable' | 'afterDisable', Callback> = {
    dirtyEnable: () => {},
    disable: () => {},
    afterDisable: () => {},
  }

  private watchers = new Map<() => unknown, Map<Callback, WatchStopHandle>>()

  constructor(id: string) {
    this.id = id
  }

  subscribe(event: unknown, callback: Callback): this {
    const parsed = parseEvent(event)
    switch (parsed.kind) {
      case 'state': {
        const byCallback = this.watchers.get(parsed.watcher) ?? new Map<Callback, WatchStopHandle>()
        this.watchers.set(parsed.watcher, byCallback)
        byCallback.get(callback)?.()
        byCallback.set(callback, watch(parsed.watcher, (value) => callback(value)))
        break
      }
      case 'lifecycle':
        if (parsed.id === 'dirty-enable') this.lifecycle.dirtyEnable = callback
        else if (parsed.timing === 'before') this.lifecycle.disable = callback
        else this.lifecycle.afterDisable = callback
        break
      case 'hook': {
        const list = hooks[parsed.id][parsed.timing]
        if (parsed.position === 'start') list.unshift(callback as HookFunction)
        else list.push(callback as HookFunction)
        break
      }
    }
    return this
  }

  unsubscribe(event: unknown, callback: Callback): this {
    const parsed = parseEvent(event)
    switch (parsed.kind) {
      case 'state':
        this.watchers.get(parsed.watcher)?.get(callback)?.()
        this.watchers.get(parsed.watcher)?.delete(callback)
        break
      case 'lifecycle':
        if (parsed.id === 'dirty-enable') this.lifecycle.dirtyEnable = () => {}
        else if (parsed.timing === 'before') this.lifecycle.disable = () => {}
        else this.lifecycle.afterDisable = () => {}
        break
      case 'hook': {
        const list = hooks[parsed.id][parsed.timing]
        const index = list.indexOf(callback as HookFunction)
        if (index !== -1) list.splice(index, 1)
        break
      }
    }
    return this
  }

  /* Lifecycle, driven by the runtime */
  async enable() {
    await this.lifecycle.dirtyEnable(this.id)
  }

  async disable() {
    await this.lifecycle.disable(this.id)
  }

  async afterDisable() {
    await this.lifecycle.afterDisable(this.id)
  }

  /* Logging (Settings → Plugins → this plugin shows it) */
  log(...parts: unknown[]) {
    writeLog(this.id, 'info', ...parts)
  }

  warn(...parts: unknown[]) {
    writeLog(this.id, 'warn', ...parts)
  }

  error(...parts: unknown[]) {
    writeLog(this.id, 'error', ...parts)
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
