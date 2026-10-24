import { describe, expect, test } from 'bun:test'
import { PluginBase } from '../src/base'
import { createHookRegistry } from '../src/hooks'

describe('hooks and plugin base', () => {
  test('before can stop, after can replace, throwing hooks are skipped', async () => {
    const errors: string[] = []
    const hooks = createHookRegistry(['onCall'] as const, (name, timing) => errors.push(`${name}.${timing}`))
    const plugin = new PluginBase('demo', hooks, () => {})

    expect(await hooks.wrap('onCall', 1, async (n) => n + 1)).toBe(2)

    plugin.subscribe('hook::onCall::after', () => {
      throw new Error('boom')
    })
    plugin.subscribe('hook::onCall::after', (result: number) => ({ status: 'stop', response: result * 10 }))
    expect(await hooks.wrap('onCall', 1, async (n) => n + 1)).toBe(20)
    expect(errors).toEqual(['onCall.after'])

    const stopper = () => ({ status: 'stop' as const, response: -1 })
    plugin.subscribe('hook::onCall::before::start', stopper)
    expect(await hooks.wrap('onCall', 1, async (n) => n + 1)).toBe(-1)
    plugin.unsubscribe('hook::onCall::before', stopper)
    expect(hooks.points.onCall.before).toHaveLength(0)
  })

  test('lifecycle callbacks and unknown events', async () => {
    const hooks = createHookRegistry([] as const, () => {})
    const plugin = new PluginBase('demo', hooks, () => {})
    const calls: string[] = []
    plugin.subscribe('lifecycle::disable', () => calls.push('disable')).subscribe('lifecycle::dirty-enable', () => calls.push('enable'))
    await plugin.disable()
    await plugin.enable()
    expect(calls).toEqual(['disable', 'enable'])
    expect(() => plugin.subscribe('hook::nope::before', () => {})).toThrow()
    expect(() => plugin.subscribe(42, () => {})).toThrow()
  })
})
