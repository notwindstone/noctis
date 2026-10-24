#!/usr/bin/env node
/**
 * Pack a plugin folder (index.js + metadata.json) into a .noctis archive.
 *
 *   node scripts/pack-plugin.mjs examples/plugins/demo-source [out-dir]
 *
 * The archive's file name is the plugin id, so it's named after the folder.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

const folder = process.argv[2]
if (!folder) {
  console.error('Usage: node scripts/pack-plugin.mjs <plugin-folder> [out-dir]')
  process.exit(1)
}

const dir = resolve(folder)
const outDir = resolve(process.argv[3] ?? 'dist-plugins')
const id = basename(dir)

const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
if (metadata.type !== 'unrestricted') {
  console.error('metadata.json "type" must be "unrestricted"')
  process.exit(1)
}

const archive = zipSync({
  'index.js': strToU8(readFileSync(join(dir, 'index.js'), 'utf8')),
  'metadata.json': strToU8(JSON.stringify(metadata, null, 2)),
})

mkdirSync(outDir, { recursive: true })
const out = join(outDir, `${id}.noctis`)
writeFileSync(out, archive)
console.log(`Packed ${metadata.name} ${metadata.version ?? ''} → ${out} (${archive.length} bytes)`)
