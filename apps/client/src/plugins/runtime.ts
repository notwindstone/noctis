import { describeProblem, resolveLoadOrder } from '@noctis/plugin-core'
import { shallowReactive } from 'vue'
import { writeLog } from './log'
import { setServicesReady } from '../services/registry'
import { noctisNamespace, type NoctisNamespace } from './namespace'
import { PluginAPI } from './plugin-api'
import { installedPlugins, isEnabled, pluginsActive, setEnabledFlag, type InstalledPlugin } from './store'

/**
 * Runs plugins. There's no sandbox: a plugin's `index.js` is the body of an async
 * function executed in the app's own context (top-level `await` works), receiving
 *
 *   scopedThis.Plugin  — its PluginAPI (hooks, lifecycle, registries, log, storage)
 *   scopedThis.Noctis  — window.__NOCTIS__ (registries, libraries, Vue)
 *
 * Lifecycle, as in Kaede: the first enable in a session runs the code ("clean");
 * disabling calls the plugin's `lifecycle::disable` callbacks; enabling again in the same
 * session calls `lifecycle::dirty-enable` instead of re-running the code.
 */

/** What a plugin's code receives as `scopedThis`. */
export interface PluginScope {
  Plugin: PluginAPI
  Noctis: NoctisNamespace
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

/** sha256 → API of code that has run in this session. */
const executed = new Map<string, PluginAPI>()

/** "starting": its code is running for the first time (it may already call servers). */
export type PluginRunState = 'starting' | 'running' | 'stopped' | 'failed'

/** sha256 → what happened to it in this session. */
export const runStates = shallowReactive<Record<string, PluginRunState>>({})

async function cleanRun(plugin: InstalledPlugin): Promise<boolean> {
  runStates[plugin.sha256] = 'starting'
  const api = new PluginAPI(plugin.id)
  const started = performance.now()
  try {
    const scope: PluginScope = { Plugin: api, Noctis: noctisNamespace() }
    await new AsyncFunction('scopedThis', plugin.code)(scope)
  } catch (error) {
    writeLog(plugin.id, 'error', 'Failed to start:', error)
    runStates[plugin.sha256] = 'failed'
    return false
  }
  executed.set(plugin.sha256, api)
  runStates[plugin.sha256] = 'running'
  writeLog(plugin.id, 'info', `Started in ${(performance.now() - started).toFixed(1)} ms`)
  return true
}

/** Enable (and run) a plugin. Resolves to false if it failed to start. */
export async function enablePlugin(plugin: InstalledPlugin): Promise<boolean> {
  const existing = executed.get(plugin.sha256)
  if (existing) {
    try {
      await existing.enable()
    } catch (error) {
      writeLog(plugin.id, 'error', 'dirty-enable threw:', error)
    }
    runStates[plugin.sha256] = 'running'
    setEnabledFlag(plugin, true)
    return true
  }

  // With plugins switched off globally, only remember the choice.
  if (!pluginsActive.value) {
    setEnabledFlag(plugin, true)
    return true
  }

  const ok = await cleanRun(plugin)
  setEnabledFlag(plugin, ok)
  return ok
}

export async function disablePlugin(plugin: InstalledPlugin) {
  setEnabledFlag(plugin, false)
  const api = executed.get(plugin.sha256)
  if (!api || runStates[plugin.sha256] !== 'running') return
  try {
    await api.disable()
    await api.afterDisable()
  } catch (error) {
    writeLog(plugin.id, 'error', 'disable threw:', error)
  }
  runStates[plugin.sha256] = 'stopped'
}

export async function removePlugin(plugin: InstalledPlugin) {
  await disablePlugin(plugin)
  installedPlugins.value = installedPlugins.value.filter((item) => item.id !== plugin.id)
}

/**
 * Run every enabled plugin, dependencies first, otherwise in install order. Plugins whose
 * dependencies are missing or the wrong version don't start (and stay enabled, so they
 * start once the dependency is fixed). Called once at startup; content requests wait
 * for it (see servicesReady).
 */
export async function startPlugins() {
  try {
    if (!pluginsActive.value) {
      writeLog('noctis', 'info', 'Plugins are switched off; none were started')
      return
    }
    const enabled = installedPlugins.value.filter(isEnabled)
    const { order, problems } = resolveLoadOrder(enabled.map(({ id, metadata }) => ({ id, manifest: metadata })))
    for (const problem of problems) writeLog(problem.id, 'error', `Not started: ${describeProblem(problem)}`)
    for (const id of order) {
      const plugin = enabled.find((item) => item.id === id)!
      if (!(await cleanRun(plugin))) setEnabledFlag(plugin, false)
    }
  } finally {
    setServicesReady()
  }
}

export function isRunning(plugin: InstalledPlugin): boolean {
  return runStates[plugin.sha256] === 'running'
}

/**
 * Turn the whole plugin system off (stops running plugins without forgetting which are
 * enabled) or back on (starts the enabled ones).
 */
export async function setPluginsActive(active: boolean) {
  pluginsActive.value = active
  for (const plugin of installedPlugins.value) {
    if (!isEnabled(plugin)) continue
    const api = executed.get(plugin.sha256)
    if (!active && api && runStates[plugin.sha256] === 'running') {
      try {
        await api.disable()
        await api.afterDisable()
      } catch (error) {
        writeLog(plugin.id, 'error', 'disable threw:', error)
      }
      runStates[plugin.sha256] = 'stopped'
    } else if (active && runStates[plugin.sha256] !== 'running') {
      const ok = api ? (await api.enable().then(() => true, () => false)) : await cleanRun(plugin)
      if (api && ok) runStates[plugin.sha256] = 'running'
      if (!ok) setEnabledFlag(plugin, false)
    }
  }
}
