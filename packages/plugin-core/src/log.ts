/** Plugin log entries, shared by the client's in-app log and the server's. */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  time: number
  /** Plugin id, or "noctis" for the plugin system itself. */
  source: string
  level: LogLevel
  message: string
}

export type LogWriter = (source: string, level: LogLevel, ...parts: unknown[]) => void

/** Join log arguments into one line: errors as "Name: message", objects as JSON. */
export function formatLogParts(parts: unknown[]): string {
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
