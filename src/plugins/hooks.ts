import { writeLog } from './log'

/**
 * Hooks: named points where plugins can intercept the app, Kaede-style.
 *
 * Every hook point has `before` and `after` lists. A hook receives one argument and
 * may return `{ status, response }`:
 *
 * - `before` hooks get the call's input (which they may mutate). Returning
 *   `{ status: "stop", response }` skips the original function and every later hook;
 *   `response` becomes the result.
 * - `after` hooks get the result (which they may mutate). `{ status: "stop", response }`
 *   replaces the result and skips later `after` hooks.
 * - Returning nothing, or `{ status: "continue" }`, carries on as if the hook didn't exist.
 *
 * A hook that throws is logged and skipped; a plugin bug never breaks the app.
 *
 * There are few hooks on purpose. Content comes from services (src/services), so a
 * plugin adds a streaming service with `defineService` rather than hooks; `onRequest`
 * sees every service call, for the cases where one plugin changes another's results.
 */

export type HookStatus = 'continue' | 'stop'

export interface HookResponse<T = unknown> {
  status: HookStatus
  response?: T
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookFunction = (value: any) => HookResponse | void | Promise<HookResponse | void>

export interface HookPoint {
  before: HookFunction[]
  after: HookFunction[]
}

/** Every hook point, with what `before` receives → what the call returns. */
export const HOOK_NAMES = [
  // Every service call (src/services/api.ts):
  //   before: { service, endpoint, input } — change any of them to reroute the call,
  //           or stop with the response yourself;
  //   after:  { service, endpoint, input, result } — change `result`, or stop with a
  //           replacement.
  'onRequest',
  // A song is about to play: before { song, index } ("stop" skips it); after, once it plays.
  'onPlay',
] as const

export type HookName = (typeof HOOK_NAMES)[number]

export const hooks = Object.fromEntries(
  HOOK_NAMES.map((name): [HookName, HookPoint] => [name, { before: [], after: [] }]),
) as Record<HookName, HookPoint>

export function isHookName(name: string): name is HookName {
  return (HOOK_NAMES as readonly string[]).includes(name)
}

type Outcome<T> = { stopped: true; response: T } | { stopped: false }

export async function runHooks<T>(name: HookName, timing: 'before' | 'after', value: unknown): Promise<Outcome<T>> {
  // Copy: a hook may (un)subscribe while the list runs.
  for (const hook of [...hooks[name][timing]]) {
    let result: HookResponse | void
    try {
      result = await hook(value)
    } catch (error) {
      writeLog('noctis', 'error', `A ${name}.${timing} hook threw:`, error)
      continue
    }
    if (result && result.status === 'stop') return { stopped: true, response: result.response as T }
  }
  return { stopped: false }
}

/**
 * Run `call` with `name`'s hooks around it. With no hooks registered this costs two
 * array length checks, so every API call can go through it.
 */
export async function withHooks<I, T>(name: HookName, input: I, call: (input: I) => Promise<T>): Promise<T> {
  const point = hooks[name]

  if (point.before.length > 0) {
    const before = await runHooks<T>(name, 'before', input)
    if (before.stopped) return before.response
  }

  const result = await call(input)

  if (point.after.length > 0) {
    const after = await runHooks<T>(name, 'after', result)
    if (after.stopped) return after.response
  }

  return result
}

/** Run only the `before` hooks (for points that don't wrap a single call, like onPlay). */
export function runBeforeHooks<T>(name: HookName, input: unknown) {
  return hooks[name].before.length > 0 ? runHooks<T>(name, 'before', input) : Promise.resolve({ stopped: false } as Outcome<T>)
}

export function runAfterHooks(name: HookName, value: unknown) {
  if (hooks[name].after.length > 0) void runHooks(name, 'after', value)
}
