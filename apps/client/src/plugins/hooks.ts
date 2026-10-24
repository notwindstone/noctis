import { createHookRegistry, type HookOutcome, type HookTiming } from '@noctis/plugin-core'
import { writeLog } from './log'

/**
 * The client's hook points. The engine (before/after lists, "stop" responses, skipping
 * hooks that throw) is shared with the server: see @noctis/plugin-core's hooks.ts.
 *
 * There are few hooks on purpose. Content comes from services (src/services), so a
 * plugin adds a streaming service with `defineService` rather than hooks; `onRequest`
 * sees every service call, for the cases where one plugin changes another's results.
 */

export type { HookFunction, HookPoint, HookResponse, HookStatus } from '@noctis/plugin-core'

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

export const hookRegistry = createHookRegistry(HOOK_NAMES, (name, timing, error) => {
  writeLog('noctis', 'error', `A ${name}.${timing} hook threw:`, error)
})

export const hooks = hookRegistry.points
export const isHookName = hookRegistry.isHookName

export function runHooks<T>(name: HookName, timing: HookTiming, value: unknown): Promise<HookOutcome<T>> {
  return hookRegistry.run<T>(name, timing, value)
}

export function withHooks<I, T>(name: HookName, input: I, call: (input: I) => Promise<T>): Promise<T> {
  return hookRegistry.wrap(name, input, call)
}

export function runBeforeHooks<T>(name: HookName, input: unknown) {
  return hookRegistry.runBefore<T>(name, input)
}

export function runAfterHooks(name: HookName, value: unknown) {
  hookRegistry.runAfter(name, value)
}
