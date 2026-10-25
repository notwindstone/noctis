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
  // An OpenSubsonic call (/rest/<endpoint>): before { endpoint, params, user } — stop with
  // a payload object (merged into "subsonic-response") or a Response to answer it
  // yourself; after { endpoint, params, user, response } — change `response` (the
  // payload) or stop with a replacement.
  'onSubsonic',
  // Audio is about to be streamed: before { song, sources, user, range } — reorder or
  // filter `sources`, or stop with a Response to stream it yourself.
  'onStream',
  // Recommendations (src/catalog/recommend.ts): before { user, seed, limit, context } —
  // stop with song ids to replace the algorithm; after { …, songIds } — change them.
  'onRecommend',
  // A song's sources for Noctis clients (src/catalog/sources.ts): after { song, user,
  // sources } — add, remove or reorder `sources` (or stop with a replacement list).
  'onSources',
] as const

export type ServerHookName = (typeof SERVER_HOOK_NAMES)[number]

export function createServerHooks() {
  return createHookRegistry(SERVER_HOOK_NAMES, (name, timing, error) => {
    writeLog('noctis', 'error', `A ${name}.${timing} hook threw:`, error)
  })
}

export type ServerHooks = ReturnType<typeof createServerHooks>
