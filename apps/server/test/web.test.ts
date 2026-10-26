import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webClient } from '../src/web'

let dir: string
let serve: ReturnType<typeof webClient>
const get = (path: string, method = 'GET') => serve(new Request(`http://noctis.test${path}`, { method }))

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'noctis-web-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><title>Noctis</title></head><body></body></html>')
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
  await writeFile(join(dir, 'favicon.svg'), '<svg/>')
  await writeFile(join(tmpdir(), 'noctis-secret.txt'), 'secret')
  serve = webClient(dir)
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('web client', () => {
  test('the app at /, marked as served by this server', async () => {
    const response = (await get('/'))!
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toContain('<meta name="noctis-server" content="same-origin">')
  })

  test('assets, cached forever', async () => {
    const response = (await get('/assets/index-abc.js'))!
    expect(await response.text()).toBe('console.log(1)')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await (await get('/favicon.svg'))!.text()).toBe('<svg/>')
  })

  test('unknown pages get the app; missing files and APIs are not its business', async () => {
    expect(await (await get('/some/page'))!.text()).toContain('<title>Noctis</title>')
    expect(await get('/assets/missing.js')).toBeNull()
    for (const path of ['/rest/ping', '/api/noctis/v1/info', '/noctis/v1/info', '/api/plugins/x/y', '/rest']) expect(await get(path)).toBeNull()
    expect(await get('/', 'POST')).toBeNull()
  })

  test('a rebuild is picked up without a restart', async () => {
    expect(await (await get('/'))!.text()).toContain('<title>Noctis</title>')
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><title>Rebuilt</title></head><body></body></html>')
    // Make sure the modification time moves even on coarse-grained file systems.
    const later = new Date(Date.now() + 5000)
    await utimes(join(dir, 'index.html'), later, later)
    expect(await (await get('/'))!.text()).toContain('<title>Rebuilt</title>')
  })

  test("can't escape the build directory", async () => {
    for (const path of ['/../noctis-secret.txt', '/%2e%2e/noctis-secret.txt', '/assets/../../noctis-secret.txt']) {
      const response = await get(path)
      expect(response === null || !(await response.text()).includes('secret')).toBe(true)
    }
  })
})
