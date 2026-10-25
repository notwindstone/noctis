import { createApp, SERVER_VERSION, withCors } from './app'
import { loadConfig } from './config'
import { writeLog } from './log'
import { createServices } from './services'

const config = loadConfig()
const services = await createServices(config)
const { plugins } = services
await plugins.load(await plugins.discover())

const app = createApp(services)
const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  maxRequestBodySize: config.maxBodyBytes,
  // Streams can be long; don't cut them off.
  idleTimeout: 0,
  fetch: withCors((request) => app.handle(request)),
})

const running = [...plugins.plugins.values()].filter((plugin) => plugin.state === 'running').length
writeLog('noctis', 'info', `${config.name} ${SERVER_VERSION} on ${server.url} · OpenSubsonic at /rest · ${running}/${plugins.plugins.size} plugins running`)

async function shutdown() {
  writeLog('noctis', 'info', 'Shutting down')
  await server.stop()
  await plugins.stopAll()
  await services.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
