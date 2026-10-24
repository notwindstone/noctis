import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { clientArchiveOf, PluginArchiveError, readPluginArchive, writePluginArchive } from '../src/archive'
import { parseManifest } from '../src/manifest'

const both = parseManifest({ name: 'Stats', type: 'unrestricted', side: 'both', version: '1.0.0' })

describe('archives', () => {
  test('round-trips both halves', () => {
    const bytes = writePluginArchive({ manifest: both, client: 'client()', server: 'export default () => {}' })
    const archive = readPluginArchive('Stats.noctis', bytes)
    expect(archive.id).toBe('stats')
    expect(archive.client).toBe('client()')
    expect(archive.server).toBe('export default () => {}')
    expect(archive.manifest.client?.required).toBe(true)
  })

  test('finds files inside a single top-level folder', () => {
    const bytes = zipSync({ 'lyrics/metadata.json': strToU8('{"name":"Lyrics","type":"unrestricted"}'), 'lyrics/index.js': strToU8('1') })
    expect(readPluginArchive('lyrics.zip', bytes).client).toBe('1')
  })

  test('a both-sides plugin needs both halves', () => {
    const bytes = writePluginArchive({ manifest: both, client: 'client()' })
    expect(() => readPluginArchive('stats.noctis', bytes)).toThrow(PluginArchiveError)
  })

  test("a client never gets the server half, and sees a client plugin", () => {
    const archive = readPluginArchive('stats.noctis', writePluginArchive({ manifest: both, client: 'c', server: 's' }))
    const forClient = readPluginArchive('stats.noctis', clientArchiveOf(archive))
    expect(forClient.manifest.side).toBe('client')
    expect(forClient.server).toBeUndefined()
    expect(forClient.manifest.version).toBe('1.0.0')
  })

  test('rejects bad file names and non-zips', () => {
    expect(() => readPluginArchive('../evil.noctis', new Uint8Array())).toThrow(PluginArchiveError)
    expect(() => readPluginArchive('ok.noctis', strToU8('not a zip'))).toThrow(PluginArchiveError)
  })
})
