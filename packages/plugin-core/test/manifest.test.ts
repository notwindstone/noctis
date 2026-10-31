import { describe, expect, test } from 'bun:test'
import { describePlatforms, ManifestError, parseManifest, supportsPlatform } from '../src/manifest'

describe('manifests', () => {
  test('an old client plugin still validates, with defaults', () => {
    const manifest = parseManifest({ name: 'Lyrics', type: 'unrestricted' })
    expect(manifest.side).toBe('client')
    expect(manifest.version).toBe('')
    expect(manifest.dependencies).toEqual({})
    expect(manifest.platforms).toEqual(['*'])
    expect(manifest.client).toBeUndefined()
  })

  test('platforms: a list, or "*" for every one', () => {
    const android = parseManifest({ name: 'x', type: 'unrestricted', platforms: ['Android', 'android', 'web'] })
    expect(android.platforms).toEqual(['android', 'web'])
    expect(supportsPlatform(android, 'web')).toBe(true)
    expect(supportsPlatform(android, 'desktop')).toBe(false)
    expect(describePlatforms(android)).toBe('Android and Web')
    expect(parseManifest({ name: 'x', type: 'unrestricted', platforms: '*' }).platforms).toEqual(['*'])
    expect(parseManifest({ name: 'x', type: 'unrestricted', platforms: ['web', '*'] }).platforms).toEqual(['*'])
    // Manifests stored before the field existed run everywhere.
    expect(supportsPlatform({}, 'ios')).toBe(true)
  })

  test('incompatible plugins and host requirements', () => {
    const manifest = parseManifest({
      name: 'x', type: 'unrestricted',
      incompatible: ['old-ui'], requires: { api: '^1.0.0', libs: ['offline', 'offline', 'player'] },
    })
    expect(manifest.incompatible).toEqual({ 'old-ui': '*' })
    expect(manifest.requires).toEqual({ api: '^1.0.0', libs: ['offline', 'player'] })
    expect(parseManifest({ name: 'x', type: 'unrestricted', incompatible: { a: '<2.0.0' } }).incompatible).toEqual({ a: '<2.0.0' })
    expect(parseManifest({ name: 'x', type: 'unrestricted' }).requires).toEqual({ libs: [] })
    expect(() => parseManifest({ name: 'x', type: 'unrestricted', incompatible: { 'Bad Id': '*' } })).toThrow(ManifestError)
    expect(() => parseManifest({ name: 'x', type: 'unrestricted', requires: { api: 'soon' } })).toThrow(ManifestError)
    expect(parseManifest({ name: 'x', type: 'unrestricted', logo: 'icon.png' }).logo).toBe('icon.png')
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
    ['empty platforms', { name: 'x', type: 'unrestricted', platforms: [] }],
    ['bad platform', { name: 'x', type: 'unrestricted', platforms: ['Windows 11'] }],
  ]
  for (const [label, value] of bad) {
    test(`rejects: ${label}`, () => {
      expect(() => parseManifest(value)).toThrow(ManifestError)
    })
  }
})
