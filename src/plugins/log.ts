import { shallowRef } from 'vue'

/**
 * A small in-app log for the plugin system. Phones have no console, so plugin output,
 * errors and registry conflict warnings are kept here and shown in Settings → Plugins.
 */

export type PluginLogLevel = 'info' | 'warn' | 'error'

export interface PluginLogEntry {
  time: number
  /** Plugin id, or "noctis" for the plugin system itself. */
  source: string
  level: PluginLogLevel
  message: string
}

const LIMIT = 400

export const pluginLog = shallowRef<PluginLogEntry[]>([])

function format(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof Error) return `${part.name}: ${part.message}`
      if (typeof part === 'string') return part
      try {
        return JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(' ')
}

export function writeLog(source: string, level: PluginLogLevel, ...parts: unknown[]) {
  const message = format(parts)
  const method = level === 'info' ? 'log' : level
  console[method](`[${source}]`, ...parts)
  pluginLog.value = [...pluginLog.value.slice(-(LIMIT - 1)), { time: Date.now(), source, level, message }]
}

export function clearLog(source?: string) {
  pluginLog.value = source ? pluginLog.value.filter((entry) => entry.source !== source) : []
}
