import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGINS_HEADER, parseManifest, readPluginArchive, sha256Hex, writePluginArchive, type HandshakeResponse } from '@noctis/plugin-core'
import { startTestServer, type TestServer } from './helpers'

const EXAMPLE = join(import.meta.dir, '../../../examples/plugins/play-stats')

let server: TestServer
const STATS = 'play-stats@1.0.0'
const call = (path: string, init: RequestInit & { plugins?: string } = {}) =>
  server.fetch(new Request(`http://noctis.test${path}`, { ...init, headers: { ...(init.plugins !== undefined ? { [PLUGINS_HEADER]: init.plugins } : {}), ...(init.headers as Record<string, string>) } }))

beforeAll(async () => {
  server = await startTestServer({}, async (dataDir) => {
    const dir = join(dataDir, 'plugins')
    await mkdir(dir, { recursive: true })
    // A both-sides plugin as an unpacked folder (the real example).
    await cp(EXAMPLE, join(dir, 'play-stats'), { recursive: true })
    // A server-only plugin as an archive, depending on play-stats.
    await writeFile(
      join(dir, 'greeter.noctis'),
      writePluginArchive({
        manifest: parseManifest({ name: 'Greeter', type: 'unrestricted', side: 'server', version: '0.3.0', dependencies: { 'play-stats': '^1.0.0' } }),
        server: `export default ({ Plugin }) => { Plugin.routes((app) => app.get('/hello', () => ({ hello: 'world' }))) }`,
      }),
    )
    // Broken ones: a missing dependency, and code that throws.
    await writeFile(
      join(dir, 'lonely.noctis'),
      writePluginArchive({ manifest: parseManifest({ name: 'Lonely', type: 'unrestricted', side: 'server', version: '1.0.0', dependencies: { ghost: '*' } }), server: 'export default () => {}' }),
    )
    await writeFile(
      join(dir, 'crashy.noctis'),
      writePluginArchive({ manifest: parseManifest({ name: 'Crashy', type: 'unrestricted', side: 'server', version: '1.0.0' }), server: "export default () => { throw new Error('nope') }" }),
    )
    await writeFile(join(dir, 'garbage.noctis'), 'not a zip')
  })
})

afterAll(() => server.close())

describe('loading', () => {
  test('states', () => {
    const state = Object.fromEntries([...server.services.plugins.plugins].map(([id, plugin]) => [id, plugin.state]))
    expect(state).toEqual({ 'play-stats': 'running', greeter: 'running', lonely: 'skipped', crashy: 'failed' })
    expect(server.services.plugins.plugins.get('lonely')!.reason).toContain("ghost")
  })
})

describe('negotiation', () => {
  test('handshake lists what a bare client is missing', async () => {
    const response = await call('/api/noctis/v1/handshake', { plugins: '' })
    const body = (await response.json()) as HandshakeResponse
    expect(response.status).toBe(200)
    expect(body.result.ok).toBe(false)
    expect(body.result.missing.map((item) => item.id)).toEqual(['play-stats'])
    expect(body.plugins[0].download).toBe('/api/noctis/v1/plugins/play-stats/client.noctis')
  })

  test('Noctis lives under /api/noctis/v1; the old /noctis/v1 is gone and plugin routes stay at /api/plugins', async () => {
    expect((await call('/api/noctis/v1/info')).status).toBe(200)
    expect((await call('/noctis/v1/info')).status).toBe(404)
    expect((await call('/api/plugins/greeter/hello', { plugins: STATS })).status).toBe(200)
  })

  test('enforced: other routes answer 428 with the handshake', async () => {
    const response = await call('/api/plugins/greeter/hello')
    expect(response.status).toBe(428)
    expect(((await response.json()) as HandshakeResponse).result.missing[0].id).toBe('play-stats')
  })

  test('outdated client halves are refused too', async () => {
    const response = await call('/api/plugins/greeter/hello', { plugins: 'play-stats@0.9.0' })
    expect(response.status).toBe(428)
    expect(((await response.json()) as HandshakeResponse).result.outdated[0].installed).toBe('0.9.0')
  })

  test('with the client half, everything works', async () => {
    const response = await call('/api/plugins/greeter/hello', { plugins: `${STATS},something-else@2.0.0` })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hello: 'world' })
  })

  test('the client half downloads, verifies and contains no server code', async () => {
    const response = await call('/api/noctis/v1/plugins/play-stats/client.noctis')
    expect(response.status).toBe(200)
    // Its own type, so Android offers to open the download with Noctis.
    expect(response.headers.get('content-type')).toBe('application/x-noctis-plugin')
    const archive = readPluginArchive('play-stats.noctis', new Uint8Array(await response.arrayBuffer()))
    expect(archive.manifest.side).toBe('client')
    expect(archive.server).toBeUndefined()
    const { plugins: requirements } = (await (await call('/api/noctis/v1/handshake')).json()) as HandshakeResponse
    expect(await sha256Hex(archive.client!)).toBe(requirements[0].sha256)
    expect((await call('/api/noctis/v1/plugins/greeter/client.noctis')).status).toBe(404)
  })
})

describe('plugin routes', () => {
  test('play-stats counts plays and validates input', async () => {
    const song = { id: 'abc', title: 'Luminous Memory', artists: [{ name: 'Mitsukiyo' }] }
    const post = (body: unknown) =>
      call('/api/plugins/play-stats/plays', { method: 'POST', plugins: STATS, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await (await post({ song })).json()).toEqual({ plays: 1 })
    expect(await (await post({ song })).json()).toEqual({ plays: 2 })
    expect((await post({ song: { id: '' } })).status).toBe(422)

    const top = (await (await call('/api/plugins/play-stats/top', { plugins: STATS })).json()) as { plays: number; song: { title: string } }[]
    expect(top[0]).toMatchObject({ plays: 2, song: { title: 'Luminous Memory' } })
  })

  test('unknown and failed plugins 404', async () => {
    expect((await call('/api/plugins/crashy/x', { plugins: STATS })).status).toBe(404)
    expect((await call('/api/plugins/nope/x', { plugins: STATS })).status).toBe(404)
  })

  test('CORS preflight and headers', async () => {
    const preflight = await call('/api/noctis/v1/info', { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain(PLUGINS_HEADER)
    expect((await call('/api/noctis/v1/info')).headers.get('access-control-allow-origin')).toBe('*')
  })

  test('storage survives a restart', async () => {
    await server.restart()
    const top = (await (await call('/api/plugins/play-stats/top', { plugins: STATS })).json()) as { plays: number }[]
    expect(top[0].plays).toBe(2)
  })
})

describe('without enforcement', () => {
  test("only the plugin's own routes check", async () => {
    await server.restart({ NOCTIS_ENFORCE_CLIENT_PLUGINS: 'false' })
    expect((await call('/api/plugins/greeter/hello')).status).toBe(200)
    expect((await call('/api/plugins/play-stats/top')).status).toBe(428)
  })
})
