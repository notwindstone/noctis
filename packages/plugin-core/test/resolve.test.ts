import { describe, expect, test } from 'bun:test'
import { hostProblems, resolveLoadOrder } from '../src/resolve'

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

  test('incompatible plugins: the one listed first stays, whoever declares it', () => {
    const declared = { id: 'b', manifest: { version: '1.0.0', dependencies: {}, incompatible: { a: '*' } } }
    const { order, problems } = resolveLoadOrder([plugin('a', '1.0.0'), declared, plugin('c', '1.0.0')])
    expect(order).toEqual(['a', 'c'])
    expect(problems).toEqual([{ id: 'b', kind: 'incompatible', other: 'a' }])
    // Declared by the earlier one, and only for versions in the range.
    const earlier = { id: 'a', manifest: { version: '1.0.0', dependencies: {}, incompatible: { b: '<2.0.0' } } }
    expect(resolveLoadOrder([earlier, plugin('b', '1.5.0')]).order).toEqual(['a'])
    expect(resolveLoadOrder([earlier, plugin('b', '2.0.0')]).order).toEqual(['a', 'b'])
  })

  test('host requirements', () => {
    const host = { api: '1.2.0', libs: ['player'] }
    expect(hostProblems('x', { api: '^1.0.0', libs: ['player'] }, host)).toEqual([])
    expect(hostProblems('x', { api: '^2.0.0', libs: ['offline'] }, host)).toHaveLength(2)
    expect(hostProblems('x', undefined, host)).toEqual([])
  })

  test('cycles are reported and skipped', () => {
    const { order, problems } = resolveLoadOrder([plugin('x', '1.0.0', { y: '*' }), plugin('y', '1.0.0', { x: '*' }), plugin('z', '1.0.0')])
    expect(order).toEqual(['z'])
    expect(problems.some((problem) => problem.kind === 'cycle')).toBe(true)
  })
})
