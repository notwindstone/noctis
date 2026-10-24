import type { HookFunction, HookRegistry } from './hooks'
import type { LogWriter } from './log'

/**
 * What both the client's and the server's `scopedThis.Plugin` are built on: lifecycle
 * callbacks, hook subscriptions and logging, attributed to one plugin. Each side
 * extends it with its own registries (components and settings on the client, routes
 * and storage on the server).
 *
 * Event names, as in Kaede:
 *   "hook::<name>::<before|after>[::start|end]"   (start = before other plugins' hooks)
 *   "lifecycle::dirty-enable"                      (re-enabled without re-running the code)
 *   "lifecycle::disable[::before|after]"
 * A side may accept more kinds of events by overriding `subscribeOther`.
 *
 * Disabling only runs the plugin's `lifecycle::disable` callbacks; undoing what it
 * registered is the plugin's job.
 */

export type PluginCallback = (data: unknown) => unknown

type ParsedEvent<Name extends string> =
  | { kind: 'lifecycle'; slot: LifecycleSlot }
  | { kind: 'hook'; id: Name; timing: 'before' | 'after'; position: 'start' | 'end' }
  | { kind: 'other' }

type LifecycleSlot = 'dirtyEnable' | 'disable' | 'afterDisable'

export class PluginBase<HookName extends string = string> {
  readonly id: string
  protected readonly hookRegistry: HookRegistry<HookName>
  protected readonly writeLog: LogWriter

  private lifecycle: Record<LifecycleSlot, PluginCallback> = {
    dirtyEnable: () => {},
    disable: () => {},
    afterDisable: () => {},
  }

  constructor(id: string, hooks: HookRegistry<HookName>, writeLog: LogWriter) {
    this.id = id
    this.hookRegistry = hooks
    this.writeLog = writeLog
  }

  private parseEvent(event: unknown): ParsedEvent<HookName> {
    if (typeof event !== 'string') return { kind: 'other' }
    const [base, id, timing, position] = event.split('::')
    if (base === 'lifecycle') {
      if (id === 'dirty-enable') return { kind: 'lifecycle', slot: 'dirtyEnable' }
      if (id === 'disable') return { kind: 'lifecycle', slot: timing === 'after' ? 'afterDisable' : 'disable' }
      throw new TypeError(`Unknown lifecycle event "${event}"`)
    }
    if (base === 'hook') {
      if (!id || !this.hookRegistry.isHookName(id)) throw new TypeError(`Unknown hook "${id}"`)
      if (timing !== 'before' && timing !== 'after') throw new TypeError('Hook timing must be "before" or "after"')
      return { kind: 'hook', id, timing, position: position === 'start' ? 'start' : 'end' }
    }
    return { kind: 'other' }
  }

  /** Other event kinds (e.g. reactive getters on the client). Return false if unknown. */
  protected subscribeOther(_event: unknown, _callback: PluginCallback): boolean {
    return false
  }

  protected unsubscribeOther(_event: unknown, _callback: PluginCallback): boolean {
    return false
  }

  subscribe(event: unknown, callback: PluginCallback): this {
    const parsed = this.parseEvent(event)
    switch (parsed.kind) {
      case 'lifecycle':
        this.lifecycle[parsed.slot] = callback
        break
      case 'hook': {
        const list = this.hookRegistry.points[parsed.id][parsed.timing]
        if (parsed.position === 'start') list.unshift(callback as HookFunction)
        else list.push(callback as HookFunction)
        break
      }
      case 'other':
        if (!this.subscribeOther(event, callback)) throw new TypeError(`Unknown event "${String(event)}"`)
    }
    return this
  }

  unsubscribe(event: unknown, callback: PluginCallback): this {
    const parsed = this.parseEvent(event)
    switch (parsed.kind) {
      case 'lifecycle':
        this.lifecycle[parsed.slot] = () => {}
        break
      case 'hook': {
        const list = this.hookRegistry.points[parsed.id][parsed.timing]
        const index = list.indexOf(callback as HookFunction)
        if (index !== -1) list.splice(index, 1)
        break
      }
      case 'other':
        this.unsubscribeOther(event, callback)
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

  /* Logging */
  log(...parts: unknown[]) {
    this.writeLog(this.id, 'info', ...parts)
  }

  warn(...parts: unknown[]) {
    this.writeLog(this.id, 'warn', ...parts)
  }

  error(...parts: unknown[]) {
    this.writeLog(this.id, 'error', ...parts)
  }
}
