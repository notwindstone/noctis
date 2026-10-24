/**
 * Hooks: named points where plugins intercept the host, Kaede-style. The client and the
 * server each create a registry with their own hook names; the semantics are the same.
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
 * A hook that throws is reported through `onError` and skipped: a plugin bug never
 * breaks the host.
 */

export type HookStatus = 'continue' | 'stop'

export interface HookResponse<T = unknown> {
  status: HookStatus
  response?: T
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookFunction = (value: any) => HookResponse | void | Promise<HookResponse | void>

export type HookTiming = 'before' | 'after'

export interface HookPoint {
  before: HookFunction[]
  after: HookFunction[]
}

export type HookOutcome<T> = { stopped: true; response: T } | { stopped: false }

export interface HookRegistry<Name extends string> {
  readonly names: readonly Name[]
  readonly points: Record<Name, HookPoint>
  isHookName(name: string): name is Name
  run<T>(name: Name, timing: HookTiming, value: unknown): Promise<HookOutcome<T>>
  /** Run `call` with the hooks around it. Without hooks it costs two length checks. */
  wrap<I, T>(name: Name, input: I, call: (input: I) => Promise<T>): Promise<T>
  /** Only the `before` hooks, for points that don't wrap a single call. */
  runBefore<T>(name: Name, input: unknown): Promise<HookOutcome<T>>
  /** Only the `after` hooks, without waiting for them. */
  runAfter(name: Name, value: unknown): void
}

export function createHookRegistry<Name extends string>(
  names: readonly Name[],
  onError: (name: Name, timing: HookTiming, error: unknown) => void,
): HookRegistry<Name> {
  const points = Object.fromEntries(names.map((name): [Name, HookPoint] => [name, { before: [], after: [] }])) as Record<Name, HookPoint>

  async function run<T>(name: Name, timing: HookTiming, value: unknown): Promise<HookOutcome<T>> {
    // Copy: a hook may (un)subscribe while the list runs.
    for (const hook of [...points[name][timing]]) {
      let result: HookResponse | void
      try {
        result = await hook(value)
      } catch (error) {
        onError(name, timing, error)
        continue
      }
      if (result && result.status === 'stop') return { stopped: true, response: result.response as T }
    }
    return { stopped: false }
  }

  return {
    names,
    points,
    isHookName: (name: string): name is Name => (names as readonly string[]).includes(name),
    run,
    async wrap<I, T>(name: Name, input: I, call: (input: I) => Promise<T>): Promise<T> {
      const point = points[name]
      if (point.before.length > 0) {
        const before = await run<T>(name, 'before', input)
        if (before.stopped) return before.response
      }
      const result = await call(input)
      if (point.after.length > 0) {
        const after = await run<T>(name, 'after', result)
        if (after.stopped) return after.response
      }
      return result
    },
    runBefore<T>(name: Name, input: unknown) {
      return points[name].before.length > 0 ? run<T>(name, 'before', input) : Promise.resolve({ stopped: false } as HookOutcome<T>)
    },
    runAfter(name: Name, value: unknown) {
      if (points[name].after.length > 0) void run(name, 'after', value)
    },
  }
}
