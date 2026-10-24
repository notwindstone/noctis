import { createApp, SERVER_VERSION, withCors } from './app'
import { loadConfig } from './config'
import { writeLog } from './log'
import { PluginManager } from './plugins/manager'

const config = loadConfig()
const plugins = new PluginManager(config)
await plugins.load(await plugins.discover())

const app = createApp(config, plugins)
const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  maxRequestBodySize: config.maxBodyBytes,
  fetch: withCors((request) => app.handle(request)),
})

const running = [...plugins.plugins.values()].filter((plugin) => plugin.state === 'running').length
writeLog('noctis', 'info', `${config.name} ${SERVER_VERSION} on ${server.url} · ${running}/${plugins.plugins.size} plugins running · plugins from ${config.pluginsDir}`)

async function shutdown() {
  writeLog('noctis', 'info', 'Shutting down')
  await server.stop()
  await plugins.stopAll()
  plugins.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
