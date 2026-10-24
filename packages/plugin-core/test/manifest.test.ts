import { describe, expect, test } from 'bun:test'
import { ManifestError, parseManifest } from '../src/manifest'

describe('manifests', () => {
  test('an old client plugin still validates, with defaults', () => {
    const manifest = parseManifest({ name: 'Lyrics', type: 'unrestricted' })
    expect(manifest.side).toBe('client')
    expect(manifest.version).toBe('')
    expect(manifest.dependencies).toEqual({})
    expect(manifest.client).toBeUndefined()
  })

  test('both-sides plugins require their client half by default', () => {
    const manifest = parseManifest({ name: 'Stats', type: 'unrestricted', side: 'both', version: '1.4.0' })
    expect(manifest.client).toEqual({ required: true, versions: '^1.4.0' })
  })

  test('client requirements can be relaxed', () => {
    const manifest = parseManifest({ name: 'Stats', type: 'unrestricted', side: 'both', version: '1.4.0', client: { required: false, versions: '>=1.0.0' } })
    expect(manifest.client).toEqual({ required: false, versions: '>=1.0.0' })
  })

  const bad: [string, unknown][] = [
    ['no name', { type: 'unrestricted' }],
    ['sandbox', { name: 'x', type: 'sandbox' }],
    ['unknown side', { name: 'x', type: 'unrestricted', side: 'everywhere' }],
    ['server without semver', { name: 'x', type: 'unrestricted', side: 'server', version: '1' }],
    ['bad dependency id', { name: 'x', type: 'unrestricted', dependencies: { 'Bad Id': '^1.0.0' } }],
    ['bad dependency range', { name: 'x', type: 'unrestricted', dependencies: { other: 'soon' } }],
    ['client on a server plugin', { name: 'x', type: 'unrestricted', side: 'server', version: '1.0.0', client: {} }],
    ['bad logo', { name: 'x', type: 'unrestricted', logo: 'javascript:alert(1)' }],
  ]
  for (const [label, value] of bad) {
    test(`rejects: ${label}`, () => {
      expect(() => parseManifest(value)).toThrow(ManifestError)
    })
  }
})
