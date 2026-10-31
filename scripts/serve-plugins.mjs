#!/usr/bin/env bun
/**
 * Serve your plugins as a collection while you develop them.
 *
 *   bun run serve-plugins [plugins-dir] [port]
 *
 * Packs every plugin under `plugins-dir` (default examples/plugins) into dist-plugins, writes
 * plugins.json, serves both, and packs a plugin again whenever its files change. In Noctis,
 * Settings → Plugins → Collections → "Add a collection" with the address printed below (from
 * a phone, the one with your computer's network address); after an edit, "Update all" installs
 * the new build over the old one: same id, same settings, and still enabled.
 */
import { readdirSync, statSync, watch } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { indexEntry, packPlugin, pluginFolders, writeIndex } from './pack-plugin.mjs'

const root = resolve(process.argv[2] ?? 'examples/plugins')
const port = Number(process.argv[3] ?? 4748)
const outDir = resolve('dist-plugins')

/** folder name → collection entry */
const entries = new Map()
const queue = new Set()
let timer

function writeAll() {
  writeIndex(outDir, 'Noctis plugins (development)', [...entries.values()])
}

async function pack(folder) {
  const name = basename(folder)
  try {
    const packed = await packPlugin(folder, outDir)
    entries.set(name, indexEntry(packed))
    console.log(`[${new Date().toLocaleTimeString()}] packed ${packed.manifest.name} ${packed.manifest.version} (${packed.bytes} bytes)`)
  } catch (error) {
    // Keep serving the last good build while the source is broken.
    console.error(`[${new Date().toLocaleTimeString()}] ${name}: ${error.message}`)
  }
}

for (const folder of pluginFolders(root)) await pack(folder)
writeAll()

function changed(name) {
  if (!name || name.startsWith('.') || name === 'node_modules') return
  queue.add(join(root, name))
  clearTimeout(timer)
  // Editors write in bursts.
  timer = setTimeout(async () => {
    const folders = [...queue]
    queue.clear()
    for (const folder of folders) {
      if (await Bun.file(join(folder, 'metadata.json')).exists()) await pack(folder)
      else entries.delete(basename(folder))
    }
    writeAll()
  }, 300)
}

/** Newest modification time under a folder (without descending into node_modules). */
function newest(dir) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
  }
  return latest
}

try {
  watch(root, { recursive: true }, (_event, file) => file && changed(file.split(sep)[0]))
} catch (error) {
  // Out of file watchers (Linux's inotify limit) or no recursive watching: look at the files instead.
  console.warn(`Can't watch files (${error.code ?? error.message}); checking for changes every second instead.`)
  const seen = new Map(pluginFolders(root).map((folder) => [folder, newest(folder)]))
  setInterval(() => {
    for (const folder of pluginFolders(root)) {
      const time = newest(folder)
      if (time !== seen.get(folder)) {
        seen.set(folder, time)
        changed(basename(folder))
      }
    }
  }, 1000)
}

const headers = {
  'access-control-allow-origin': '*',
  // Always the latest build, never a cached one.
  'cache-control': 'no-store',
}

Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'plugins.json'
    const file = resolve(outDir, name)
    if (relative(outDir, file).startsWith('..') || !(await Bun.file(file).exists())) return new Response('Not found', { status: 404, headers })
    return new Response(Bun.file(file), { headers })
  },
})

console.log(`Serving ${entries.size} plugins from ${relative(process.cwd(), root) || '.'}. Add one of these as a collection in Noctis:`)
console.log(`  http://localhost:${port}/plugins.json`)
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal) console.log(`  http://${address.address}:${port}/plugins.json`)
}
