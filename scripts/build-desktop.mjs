#!/usr/bin/env bun
/**
 * Desktop builds for local testing (no CI, no GitHub artifacts): one command makes what a
 * demo needs and puts it in builds/, named Noctis-<version>-<platform>[-<tag>].<ext>.
 *
 *   bun run build-desktop                  this machine's platform
 *   bun run build-desktop linux windows    several at once
 *   bun run build-desktop --tag g          adds "-g" to the file names (like the APKs)
 *
 * linux    deb, rpm and AppImage                      (on Linux)
 * windows  NSIS installer + portable zip              (on Linux with cargo-xwin + makensis, or on Windows)
 * macos    dmg + app.tar.gz, Apple silicon and Intel  (only on a Mac: Apple's SDK can't be used from Linux)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'

const root = resolve(import.meta.dir, '..')
const client = join(root, 'apps/client')
const tauri = join(client, 'src-tauri')
const out = join(root, 'builds')
const version = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8')).version

// rustup's install folder isn't on the PATH of every shell (non-login ones, IDE terminals).
process.env.PATH = `${join(homedir(), '.cargo', 'bin')}${platform() === 'win32' ? ';' : ':'}${process.env.PATH}`

const args = process.argv.slice(2)
const tagAt = args.indexOf('--tag')
const tag = tagAt >= 0 ? args.splice(tagAt, 2)[1] : ''
const host = { linux: 'linux', win32: 'windows', darwin: 'macos' }[platform()]
const wanted = args.length > 0 ? args : [host]
const suffix = tag ? `-${tag}` : ''

function run(command, argv, options = {}) {
  console.log(`\n$ ${command} ${argv.join(' ')}`)
  const result = spawnSync(command, argv, { cwd: client, stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}

/** Files directly in `dir` (or below, one level) that end with `ext`. */
function find(dir, ext) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith(ext)).map((name) => join(dir, name))
}

function publish(files, platformName, rename = (name) => name) {
  mkdirSync(out, { recursive: true })
  for (const file of files) {
    const name = file.split(/[\\/]/).pop()
    const target = join(out, `Noctis-${version}-${platformName}${suffix}-${rename(name)}`)
    copyFileSync(file, target)
    console.log(`→ ${target}`)
  }
  if (files.length === 0) console.warn(`! nothing came out for ${platformName}`)
}

function tauriBuild(extra, target) {
  run('bun', ['run', 'tauri', 'build', ...extra])
  return join(tauri, 'target', target ?? '', 'release')
}

/** The extension is kept; what's left is the part that tells builds of one platform apart. */
const kind = (name) => name.replace(/^Noctis[_-]/, '').replace(version, '').replace(/^[_-]+/, '')

const builds = {
  linux() {
    if (platform() !== 'linux') throw new Error('Linux bundles are built on Linux')
    // linuxdeploy is itself an AppImage: without FUSE (containers, CI-less boxes) it must unpack itself.
    process.env.APPIMAGE_EXTRACT_AND_RUN = '1'
    process.env.NO_STRIP = '1'
    const release = tauriBuild([])
    for (const [dir, ext] of [['deb', '.deb'], ['rpm', '.rpm'], ['appimage', '.AppImage']]) {
      publish(find(join(release, 'bundle', dir), ext), 'linux', kind)
    }
  },

  windows() {
    const target = 'x86_64-pc-windows-msvc'
    // From Linux the MSVC target is built with cargo-xwin (the MinGW one needs a loose
    // WebView2Loader.dll and crashes without it). Its toolchain wants LLVM's lld/clang.
    const cross = platform() !== 'win32' ? ['--runner', 'cargo-xwin'] : []
    const release = tauriBuild(['--target', target, ...cross, '--bundles', 'nsis'], target)
    publish(find(join(release, 'bundle', 'nsis'), '.exe'), 'windows', kind)

    // Portable: the exe next to a portable.txt keeps all data beside it (launch.rs).
    const staging = join(out, '.portable', 'Noctis-portable')
    rmSync(join(out, '.portable'), { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    copyFileSync(join(release, 'noctis-desktop.exe'), join(staging, 'Noctis.exe'))
    writeFileSync(join(staging, 'portable.txt'), 'Noctis keeps all of its data in the "data" folder next to this file.\n')
    const zip = join(out, `Noctis-${version}-windows${suffix}-portable.zip`)
    rmSync(zip, { force: true })
    if (platform() === 'win32') run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${staging}' -DestinationPath '${zip}'`])
    else run('zip', ['-qr', zip, 'Noctis-portable'], { cwd: join(out, '.portable') })
    rmSync(join(out, '.portable'), { recursive: true, force: true })
    console.log(`→ ${zip}`)
  },

  macos() {
    if (platform() !== 'darwin') {
      throw new Error('macOS bundles need a Mac (Apple\'s SDK and codesign can\'t run elsewhere): run `bun run build-desktop macos` there')
    }
    for (const [target, label] of [['aarch64-apple-darwin', 'arm64'], ['x86_64-apple-darwin', 'x64']]) {
      run('rustup', ['target', 'add', target])
      const release = tauriBuild(['--target', target, '--bundles', 'dmg,app'], target)
      publish(find(join(release, 'bundle', 'dmg'), '.dmg'), `macos-${label}`, () => 'installer.dmg')
      // The .app is a folder; tar it so it survives being uploaded.
      const app = join(release, 'bundle', 'macos')
      if (existsSync(join(app, 'Noctis.app'))) {
        const tarball = join(out, `Noctis-${version}-macos-${label}${suffix}-app.tar.gz`)
        run('tar', ['-czf', tarball, '-C', app, 'Noctis.app'])
        console.log(`→ ${tarball}`)
      }
    }
  },
}

for (const name of wanted) {
  if (!builds[name]) {
    console.error(`Unknown platform "${name}" (linux, windows, macos)`)
    process.exit(1)
  }
}
let failed = false
for (const name of wanted) {
  try {
    builds[name]()
  } catch (error) {
    failed = true
    console.error(`\n✗ ${name}: ${error.message}`)
  }
}
process.exit(failed ? 1 : 0)
