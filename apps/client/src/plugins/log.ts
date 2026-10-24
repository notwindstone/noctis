import { formatLogParts, type LogEntry, type LogLevel } from '@noctis/plugin-core'
import { shallowRef } from 'vue'

/**
 * A small in-app log for the plugin system. Phones have no console, so plugin output,
 * errors and registry conflict warnings are kept here and shown in Settings → Plugins.
 */

export type PluginLogLevel = LogLevel
export type PluginLogEntry = LogEntry

const LIMIT = 400

export const pluginLog = shallowRef<PluginLogEntry[]>([])

export function writeLog(source: string, level: PluginLogLevel, ...parts: unknown[]) {
  const message = formatLogParts(parts)
  const method = level === 'info' ? 'log' : level
  console[method](`[${source}]`, ...parts)
  pluginLog.value = [...pluginLog.value.slice(-(LIMIT - 1)), { time: Date.now(), source, level, message }]
}

export function clearLog(source?: string) {
  pluginLog.value = source ? pluginLog.value.filter((entry) => entry.source !== source) : []
}
