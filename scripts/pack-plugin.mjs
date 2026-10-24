#!/usr/bin/env node
/**
 * Pack a plugin folder (index.js + metadata.json) into a .noctis archive.
 *
 *   node scripts/pack-plugin.mjs examples/plugins/demo-source [out-dir]
 *
 * The archive's file name is the plugin id, so it's named after the folder.
 *
 * A folder with `src/index.ts` instead of `index.js` is built first: Vite bundles it
 * (TypeScript, .vue files, npm packages) into one script whose default export is called
 * with `scopedThis`. 'vue' and '@capacitor/core' aren't bundled; they're the app's own,
 * from `scopedThis.Noctis.packages`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

const SHARED = {
  vue: 'scopedThis.Noctis.packages.vue',
  '@capacitor/core': 'scopedThis.Noctis.packages.capacitor',
}

async function buildSource(entry) {
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
  const css = output.filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'))
  if (css.length > 0) throw new Error('Plugin styles are not supported yet; use the app\'s classes')
  return `${output[0].code}\nawait plugin(scopedThis)\n`
}

const entry = join(dir, 'src', 'index.ts')
const code = existsSync(entry) ? await buildSource(entry) : readFileSync(join(dir, 'index.js'), 'utf8')

const archive = zipSync({
  'index.js': strToU8(code),
  'metadata.json': strToU8(JSON.stringify(metadata, null, 2)),
})

mkdirSync(outDir, { recursive: true })
const out = join(outDir, `${id}.noctis`)
writeFileSync(out, archive)
console.log(`Packed ${metadata.name} ${metadata.version ?? ''} → ${out} (${archive.length} bytes)`)
