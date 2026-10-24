import { describe, expect, test } from 'bun:test'
import { resolveLoadOrder } from '../src/resolve'

const plugin = (id: string, version: string, dependencies: Record<string, string> = {}) => ({ id, manifest: { version, dependencies } })

describe('load order', () => {
  test('dependencies load first', () => {
    const { order, problems } = resolveLoadOrder([plugin('ui', '1.0.0', { core: '^2.0.0' }), plugin('core', '2.1.0')])
    expect(order).toEqual(['core', 'ui'])
    expect(problems).toEqual([])
  })

  test('missing and wrong versions block the plugin and its dependents', () => {
    const { order, problems } = resolveLoadOrder([
      plugin('a', '1.0.0', { b: '^1.0.0' }),
      plugin('b', '2.0.0'),
      plugin('c', '1.0.0', { a: '*' }),
      plugin('d', '1.0.0', { ghost: '*' }),
      plugin('e', '1.0.0'),
    ])
    expect(order).toEqual(['b', 'e'])
    expect(problems.map((problem) => `${problem.id}:${problem.kind}`).sort()).toEqual(['a:version', 'c:blocked', 'd:missing'])
  })

  test('cycles are reported and skipped', () => {
    const { order, problems } = resolveLoadOrder([plugin('x', '1.0.0', { y: '*' }), plugin('y', '1.0.0', { x: '*' }), plugin('z', '1.0.0')])
    expect(order).toEqual(['z'])
    expect(problems.some((problem) => problem.kind === 'cycle')).toBe(true)
  })
})
