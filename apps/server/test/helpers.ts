import { SQL } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, withCors } from '../src/app'
import { loadConfig } from '../src/config'
import { createServices, type Services } from '../src/services'

/**
 * Test servers need PostgreSQL and Redis. Each test file gets its own fresh database
 * (created on the server at NOCTIS_TEST_DATABASE_URL, dropped afterwards).
 *
 *   docker compose up -d postgres redis   # then: bun test
 */
const DATABASE_URL = process.env.NOCTIS_TEST_DATABASE_URL ?? 'postgres://noctis:noctis@localhost:5432/noctis'
const REDIS_URL = process.env.NOCTIS_TEST_REDIS_URL ?? 'redis://localhost:6379'

export interface TestServer {
  services: Services
  dataDir: string
  fetch: (request: Request) => Promise<Response>
  /** Restart on the same database and data directory, optionally with other settings. */
  restart(env?: Record<string, string>): Promise<void>
  close(): Promise<void>
}

export async function startTestServer(env: Record<string, string> = {}, prepare?: (dataDir: string) => Promise<void>): Promise<TestServer> {
  const admin = new SQL(DATABASE_URL)
  const name = `noctis_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  await admin.unsafe(`CREATE DATABASE ${name}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`

  const dataDir = await mkdtemp(join(tmpdir(), 'noctis-test-'))
  await prepare?.(dataDir)

  const server = {} as TestServer
  const boot = async (extra: Record<string, string>) => {
    const services = await createServices(
      loadConfig({ NOCTIS_DATA_DIR: dataDir, NOCTIS_DATABASE_URL: url.href, NOCTIS_REDIS_URL: REDIS_URL, NOCTIS_ADMIN_USER: 'sensei', NOCTIS_ADMIN_PASSWORD: 'correct-horse', ...env, ...extra }),
    )
    await services.plugins.load(await services.plugins.discover())
    const app = createApp(services)
    server.services = services
    server.fetch = withCors((request) => app.handle(request))
  }
  await boot({})
  server.dataDir = dataDir
  server.restart = async (extra = {}) => {
    await server.services.plugins.stopAll()
    await server.services.close()
    await boot(extra)
  }
  server.close = async () => {
    await server.services.plugins.stopAll()
    await server.services.close()
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`)
    await admin.close()
    await rm(dataDir, { recursive: true, force: true })
  }
  return server
}

/** Sign in through /noctis/v1/auth/login; resolves to the session token. */
export async function login(server: TestServer, username = 'sensei', password = 'correct-horse'): Promise<string> {
  const response = await server.fetch(
    new Request('http://noctis.test/noctis/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  )
  const body = (await response.json()) as { token?: string; error?: string }
  if (!body.token) throw new Error(`login failed: ${body.error}`)
  return body.token
}

/** A tiny PCM WAV with RIFF INFO tags, which music-metadata reads. */
export function wav(tags: Record<string, string>, samples = 8000): Uint8Array {
  const encoder = new TextEncoder()
  const chunk = (id: string, data: Uint8Array) => {
    const padded = data.length % 2 ? new Uint8Array([...data, 0]) : data
    const out = new Uint8Array(8 + padded.length)
    out.set(encoder.encode(id), 0)
    new DataView(out.buffer).setUint32(4, data.length, true)
    out.set(padded, 8)
    return out
  }
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
  const fmt = new Uint8Array(16)
  const view = new DataView(fmt.buffer)
  view.setUint16(0, 1, true) // PCM
  view.setUint16(2, 1, true) // mono
  view.setUint32(4, 8000, true)
  view.setUint32(8, 16000, true)
  view.setUint16(12, 2, true)
  view.setUint16(14, 16, true)
  const info = concat(encoder.encode('INFO'), ...Object.entries(tags).map(([id, value]) => chunk(id, encoder.encode(`${value}\0`))))
  const body = concat(encoder.encode('WAVE'), chunk('fmt ', fmt), chunk('LIST', info), chunk('data', new Uint8Array(samples * 2)))
  return concat(chunk('RIFF', body).slice(0, 8), body)
}
