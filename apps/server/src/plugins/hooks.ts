import { createHookRegistry } from '@noctis/plugin-core'
import { writeLog } from '../log'

/**
 * The server's hook points (the engine is @noctis/plugin-core's, shared with the client).
 */
export const SERVER_HOOK_NAMES = [
  // Every API request, before routing: before { request, path, clientPlugins }; stop with
  // a Response to answer it yourself (auth, rate limits, rewrites).
  'onRequest',
  // A client checking in: after { response } (the HandshakeResponse), which hooks may
  // change, e.g. to add server info.
  'onHandshake',
] as const

export type ServerHookName = (typeof SERVER_HOOK_NAMES)[number]

export function createServerHooks() {
  return createHookRegistry(SERVER_HOOK_NAMES, (name, timing, error) => {
    writeLog('noctis', 'error', `A ${name}.${timing} hook threw:`, error)
  })
}

export type ServerHooks = ReturnType<typeof createServerHooks>
