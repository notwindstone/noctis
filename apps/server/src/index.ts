import { createApp, SERVER_VERSION, withCors } from './app'
import { loadConfig } from './config'
import { writeLog } from './log'
import { createServices } from './services'
import { webClient } from './web'

const config = loadConfig()
const services = await createServices(config)
const { plugins } = services
await plugins.load(await plugins.discover())

const app = createApp(services)
const web = config.webClient ? webClient(config.webClient) : null
if (config.webClient && !(await Bun.file(`${config.webClient}/index.html`).exists())) {
  writeLog('noctis', 'warn', `No web client build in ${config.webClient}; run \`bun run build:web\` (or set NOCTIS_WEB_CLIENT=false)`)
}
const api = withCors((request) => app.handle(request))
const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  maxRequestBodySize: config.maxBodyBytes,
  // Streams can be long; don't cut them off.
  idleTimeout: 0,
  fetch: async (request) => (web && (await web(request))) || api(request),
})

const running = [...plugins.plugins.values()].filter((plugin) => plugin.state === 'running').length
writeLog('noctis', 'info', `${config.name} ${SERVER_VERSION} on ${server.url} · OpenSubsonic at /rest${web ? ' · web client at /' : ''} · ${running}/${plugins.plugins.size} plugins running`)

async function shutdown() {
  writeLog('noctis', 'info', 'Shutting down')
  await server.stop()
  await plugins.stopAll()
  await services.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
