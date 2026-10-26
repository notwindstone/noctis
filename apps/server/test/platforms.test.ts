import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLATFORM_HEADER, PLUGINS_HEADER, parseManifest, writePluginArchive, type HandshakeResponse } from '@noctis/plugin-core'
import { startTestServer, type TestServer } from './helpers'

let server: TestServer

const call = (path: string, headers: Record<string, string> = {}) => server.fetch(new Request(`http://noctis.test${path}`, { headers: { [PLUGINS_HEADER]: '', ...headers } }))

beforeAll(async () => {
  server = await startTestServer({}, async (dataDir) => {
    const dir = join(dataDir, 'plugins')
    await mkdir(dir, { recursive: true })
    // A required client half that only runs in the Android app.
    await writeFile(
      join(dir, 'phone-only.noctis'),
      writePluginArchive({
        manifest: parseManifest({ name: 'Phone only', type: 'unrestricted', side: 'both', version: '1.0.0', platforms: ['android'] }),
        server: 'export default () => {}',
        client: 'export {}',
      }),
    )
  })
})

afterAll(() => server.close())

describe('platforms', () => {
  test('the handshake says which platforms a client half runs on', async () => {
    const body = (await (await call('/api/noctis/v1/handshake')).json()) as HandshakeResponse
    expect(body.plugins[0].platforms).toEqual(['android'])
  })

  test("a plugin isn't required of clients it can't run on", async () => {
    const web = (await (await call('/api/noctis/v1/handshake', { [PLATFORM_HEADER]: 'web' })).json()) as HandshakeResponse
    expect(web.result.ok).toBe(true)
    expect(web.result.unsupported?.map((item) => item.id)).toEqual(['phone-only'])
    expect((await call('/api/noctis/v1/me', { [PLATFORM_HEADER]: 'web' })).status).not.toBe(428)
  })

  test('the platform it runs on (or an unknown one) still needs it', async () => {
    expect((await call('/api/noctis/v1/me', { [PLATFORM_HEADER]: 'android' })).status).toBe(428)
    expect((await call('/api/noctis/v1/me')).status).toBe(428)
  })
})
