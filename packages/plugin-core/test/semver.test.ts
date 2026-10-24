import { describe, expect, test } from 'bun:test'
import { compareVersions, isValidRange, parseVersion, satisfies } from '../src/semver'

describe('versions', () => {
  test('parse and compare', () => {
    const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0', '1.0.1', '1.10.0', '2.0.0']
    for (let i = 1; i < order.length; i++) {
      expect(compareVersions(parseVersion(order[i - 1])!, parseVersion(order[i])!)).toBeLessThan(0)
    }
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('v1.2.3+build.5')?.patch).toBe(3)
  })
})

describe('ranges', () => {
  const cases: [string, string, boolean][] = [
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '=1.2.3', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.2.7', '1.2.*', true],
    ['3.0.0', '*', true],
    ['1.5.0', '>=1.2 <2', true],
    ['2.0.0', '>=1.2 <2', false],
    ['1.0.0', '<1 || >=3', false],
    ['3.1.0', '<1 || >=3', true],
    ['1.5.0', '1.0.0 - 2.0.0', true],
    ['2.0.1', '1.0.0 - 2.0.0', false],
    ['1.3.0', '>1.2', true],
    ['1.2.9', '>1.2', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['2.0.0-beta.1', '^1.0.0', false],
    ['2.0.0-beta.2', '>=2.0.0-beta.1', true],
    ['2.1.0-beta.1', '>=2.0.0-beta.1', false],
    ['1.2.3', '>= 1.2.3', true],
  ]
  for (const [version, range, expected] of cases) {
    test(`${version} ${expected ? 'satisfies' : "doesn't satisfy"} ${range}`, () => {
      expect(satisfies(version, range)).toBe(expected)
    })
  }

  test('invalid', () => {
    expect(isValidRange('^banana')).toBe(false)
    expect(satisfies('nope', '*')).toBe(false)
  })
})
