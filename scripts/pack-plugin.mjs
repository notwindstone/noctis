#!/usr/bin/env bun
/**
 * Pack a plugin folder into a .noctis archive.
 *
 *   bun run pack-plugin examples/plugins/play-stats [out-dir]
 *
 * The archive's file name is the plugin id, so it's named after the folder. What goes in
 * depends on metadata.json's "side":
 *
 * - client half: src/index.ts (built with Vite: TypeScript, .vue files and npm packages,
 *   with 'vue' and '@capacitor/core' taken from the app) or index.js as it is;
 * - server half: src/server.ts (built with Bun for the server, 'elysia' left to the
 *   server) or server.js as it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseManifest, runsOnClient, runsOnServer, writePluginArchive } from '../packages/plugin-core/src/index.ts'

const folder = process.argv[2]
if (!folder) {
  console.error('Usage: bun run pack-plugin <plugin-folder> [out-dir]')
  process.exit(1)
}

const dir = resolve(folder)
const outDir = resolve(process.argv[3] ?? 'dist-plugins')
const id = basename(dir)

let manifest
try {
  manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')))
} catch (error) {
  console.error(`metadata.json: ${error.message}`)
  process.exit(1)
}

const SHARED = {
  vue: 'scopedThis.Noctis.packages.vue',
  '@capacitor/core': 'scopedThis.Noctis.packages.capacitor',
}

/** The client half: one script whose default export is called with `scopedThis`. */
async function buildClient(entry) {
  const { build } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [vue()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      target: 'es2022',
      lib: { entry, formats: ['iife'], name: 'plugin' },
      rollupOptions: { external: Object.keys(SHARED), output: { globals: SHARED } },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  if (output.some((file) => file.type === 'asset' && file.fileName.endsWith('.css'))) {
    throw new Error("Plugin styles are not supported yet; import CSS with ?raw and inject it")
  }
  return `${output[0].code}\nawait plugin(scopedThis)\n`
}

/** The server half: an ES module for Bun, `export default function ({ Plugin, Noctis })`. */
async function buildServer(entry) {
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', external: ['elysia'], minify: false })
  if (!result.success) throw new AggregateError(result.logs, 'Server build failed')
  return result.outputs[0].text()
}

async function half(source, plain, build) {
  if (existsSync(join(dir, 'src', source))) return build(join(dir, 'src', source))
  if (existsSync(join(dir, plain))) return readFileSync(join(dir, plain), 'utf8')
  throw new Error(`A "${manifest.side}" plugin needs src/${source} or ${plain}`)
}

const archive = writePluginArchive({
  manifest,
  client: runsOnClient(manifest) ? await half('index.ts', 'index.js', buildClient) : undefined,
  server: runsOnServer(manifest) ? await half('server.ts', 'server.js', buildServer) : undefined,
})

mkdirSync(outDir, { recursive: true })
const out = join(outDir, `${id}.noctis`)
writeFileSync(out, archive)
console.log(`Packed ${manifest.name} ${manifest.version} (${manifest.side}) → ${out} (${archive.length} bytes)`)
