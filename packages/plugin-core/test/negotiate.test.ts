import { describe, expect, test } from 'bun:test'
import { checkClientPlugins, decodePluginsHeader, encodePluginsHeader, type ClientPluginRequirement } from '../src/negotiate'

const requirement = (id: string, versions: string, required = true): ClientPluginRequirement => ({
  id, name: id, version: '1.0.0', versions, required, sha256: '', download: `/noctis/v1/plugins/${id}/client.noctis`,
})

describe('negotiation', () => {
  test('missing, outdated and optional plugins', () => {
    const result = checkClientPlugins(
      [requirement('stats', '^1.0.0'), requirement('lyrics', '^2.0.0'), requirement('theme', '*', false)],
      [{ id: 'lyrics', version: '1.5.0' }],
    )
    expect(result.ok).toBe(false)
    expect(result.missing.map((item) => item.id)).toEqual(['stats'])
    expect(result.outdated.map((item) => [item.requirement.id, item.installed])).toEqual([['lyrics', '1.5.0']])
    expect(result.suggested.map((item) => item.id)).toEqual(['theme'])
  })

  test('ok when everything required is there', () => {
    expect(checkClientPlugins([requirement('stats', '^1.0.0')], [{ id: 'stats', version: '1.2.0' }]).ok).toBe(true)
  })

  test('header round-trip drops junk', () => {
    const header = encodePluginsHeader([{ id: 'stats', version: '1.2.0' }, { id: 'old', version: '' }])
    expect(header).toBe('stats@1.2.0,old@0.0.0')
    expect(decodePluginsHeader(`${header},bad,@1.0.0,UP@1.0.0,x@nope`)).toEqual([
      { id: 'stats', version: '1.2.0' },
      { id: 'old', version: '0.0.0' },
    ])
  })
})
