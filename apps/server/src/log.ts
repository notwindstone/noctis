import { formatLogParts, type LogEntry, type LogLevel } from '@noctis/plugin-core'

/** The server's log: the console, plus the last entries kept for the admin API later. */

const LIMIT = 1000
export const logEntries: LogEntry[] = []

export function writeLog(source: string, level: LogLevel, ...parts: unknown[]) {
  const message = formatLogParts(parts)
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  logEntries.push({ time: Date.now(), source, level, message })
  if (logEntries.length > LIMIT) logEntries.splice(0, logEntries.length - LIMIT)
}
