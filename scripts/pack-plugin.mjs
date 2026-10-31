#!/usr/bin/env bun
/**
 * Pack a plugin folder into a .noctis archive.
 *
 *   bun run pack-plugin examples/plugins/play-stats [out-dir]
 *   bun run pack-plugin --all [plugins-dir] [out-dir]      every plugin, plus a plugins.json index
 *
 * `--all` also writes `plugins.json` next to the archives: a plugin collection (see
 * apps/client/src/plugins/collections.ts) that Noctis can install from and update from.
 * `bun run serve-plugins` does the same and keeps it up to date while you edit.
 *
 * The archive's file name is the plugin id, so it's named after the folder. What goes in
 * depends on metadata.json's "side":
 *
 * - client half: src/index.ts (built with Vite: TypeScript, .vue files and npm packages,
 *   with 'vue' and '@capacitor/core' taken from the app) or index.js as it is;
 * - server half: src/server.ts (built with Bun for the server, 'elysia' left to the
 *   server) or server.js as it is.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { LOGO_FILE, parseManifest, runsOnClient, runsOnServer, sha256Hex, writePluginArchive } from '../packages/plugin-core/src/index.ts'


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

async function half(dir, manifest, source, plain, build) {
  if (existsSync(join(dir, 'src', source))) return build(join(dir, 'src', source))
  if (existsSync(join(dir, plain))) return readFileSync(join(dir, plain), 'utf8')
  throw new Error(`A "${manifest.side}" plugin needs src/${source} or ${plain}`)
}

/** Pack one plugin folder into `<outDir>/<folder name>.noctis`. */
export async function packPlugin(folder, outDir) {
  const dir = resolve(folder)
  const id = basename(dir)
  // The archive says which plugin it is, so renaming the file (file hosts do) doesn't make it another plugin.
  const manifest = { ...parseManifest(JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))), id }
  const client = runsOnClient(manifest) ? await half(dir, manifest, 'index.ts', 'index.js', buildClient) : undefined
  const server = runsOnServer(manifest) ? await half(dir, manifest, 'server.ts', 'server.js', buildServer) : undefined
  // A logo that is a file name travels in the archive; Noctis inlines it when it installs.
  const logo = manifest.logo && LOGO_FILE.test(manifest.logo) ? join(dir, manifest.logo) : undefined
  if (logo && !existsSync(logo)) throw new Error(`metadata.json: logo "${manifest.logo}" isn't in the plugin folder`)
  const assets = logo ? { [manifest.logo]: new Uint8Array(readFileSync(logo)) } : undefined
  const archive = writePluginArchive({ manifest, client, server, assets })
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${id}.noctis`)
  writeFileSync(out, archive)
  return { id, manifest, out, bytes: archive.length, sha256: client === undefined ? undefined : await sha256Hex(client) }
}

/** The collection entry for a packed plugin, or null for server-only plugins (clients can't install those). */
export function indexEntry(packed) {
  if (!packed.sha256) return null
  const { id, manifest } = packed
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    authors: manifest.authors,
    sha256: packed.sha256,
    url: `${id}.noctis`,
  }
}

/** Folders under `root` that hold a plugin. */
export function pluginFolders(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'metadata.json')))
    .map((entry) => join(root, entry.name))
}

export function writeIndex(outDir, name, entries) {
  mkdirSync(outDir, { recursive: true })
  const sorted = entries.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync(join(outDir, 'plugins.json'), JSON.stringify({ name, plugins: sorted }, null, 2))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--all') {
    const root = resolve(args[1] ?? 'examples/plugins')
    const outDir = resolve(args[2] ?? 'dist-plugins')
    const entries = []
    for (const folder of pluginFolders(root)) {
      try {
        const packed = await packPlugin(folder, outDir)
        entries.push(indexEntry(packed))
        console.log(`Packed ${packed.manifest.name} ${packed.manifest.version} (${packed.manifest.side}) → ${packed.out} (${packed.bytes} bytes)`)
      } catch (error) {
        console.error(`${basename(folder)}: ${error.message}`)
        process.exitCode = 1
      }
    }
    writeIndex(outDir, 'Noctis example plugins', entries)
    console.log(`Wrote ${join(outDir, 'plugins.json')}`)
  } else if (args[0]) {
    try {
      const packed = await packPlugin(args[0], resolve(args[1] ?? 'dist-plugins'))
      console.log(`Packed ${packed.manifest.name} ${packed.manifest.version} (${packed.manifest.side}) → ${packed.out} (${packed.bytes} bytes)`)
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  } else {
    console.error('Usage: bun run pack-plugin <plugin-folder> [out-dir]\n       bun run pack-plugin --all [plugins-dir] [out-dir]')
    process.exit(1)
  }
}
