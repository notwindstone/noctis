import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clientArchiveOf,
  describeProblem,
  idFromFileName,
  parseManifest,
  readPluginArchive,
  requirementFor,
  resolveLoadOrder,
  runsOnServer,
  sha256Hex,
  type ClientPluginRequirement,
  type PluginArchive,
} from '@noctis/plugin-core'
import * as Elysia from 'elysia'
import { can, type User } from '../auth'
import type { ServerConfig } from '../config'
import { writeLog } from '../log'
import * as mappers from '../subsonic/mappers'
import type { Database } from '../db'
import { ServerPluginAPI, type ServerRegistries } from './api'
import { SERVER_HOOK_NAMES, type ServerHooks } from './hooks'
import { PluginStorage } from './storage'

/**
 * Server plugins: loaded from the plugins directory at startup, never through the API.
 * They're trusted code with the server's full access, like Minecraft server mods, so
 * only the instance owner can install them.
 *
 * Each plugin directory entry is a .noctis/.zip archive, or (for development) a folder
 * with metadata.json and server.js (or src/server.ts, built on load) and index.js. A plugin's server half is an ES module:
 *
 *   export default async function ({ Plugin, Noctis }) { ... }
 *
 * Plugins load dependencies first; one whose dependencies are missing, the wrong
 * version, or failed to load is skipped with the reason logged.
 */

export type PluginState = 'running' | 'stopped' | 'failed' | 'skipped'

export interface LoadedPlugin {
  archive: PluginArchive
  /** SHA-256 of the client half (index.js), for "both" plugins. */
  clientSha256?: string
  state: PluginState
  /** Why it isn't running. */
  reason?: string
  api?: ServerPluginAPI
}

export interface ServerScope {
  Plugin: ServerPluginAPI
  Noctis: ServerNamespace
}

export type ServerNamespace = ReturnType<PluginManager['namespace']>

export class PluginManager {
  readonly hooks: ServerHooks
  readonly plugins = new Map<string, LoadedPlugin>()
  private readonly storage: PluginStorage

  constructor(
    private readonly config: ServerConfig,
    private readonly registries: ServerRegistries & { db: Database; userFrom: (request: Request) => Promise<User | null> },
  ) {
    this.hooks = registries.hooks
    this.storage = new PluginStorage(registries.db)
  }

  /** What server plugins can reach as `Noctis`. */
  namespace() {
    return {
      version: '0.1.0',
      server: { name: this.config.name },
      /** The server's own Elysia (and its `t` schema builder), so plugins don't bundle one. */
      packages: { elysia: Elysia },
      hooks: this.hooks.points,
      hookNames: SERVER_HOOK_NAMES,
      /** Other plugins, read-only: id → { manifest, state }. */
      plugins: () => [...this.plugins.entries()].map(([id, plugin]) => ({ id, manifest: plugin.archive.manifest, state: plugin.state })),
      log: writeLog,
      /** The music catalog: upsertSong, setTags, removeSources, song, search, … */
      catalog: this.registries.catalog,
      /** Recommendations, after every plugin's onRecommend hooks. */
      recommend: this.registries.recommender.recommend.bind(this.registries.recommender),
      /** Defined audio providers. */
      providers: () => this.registries.providers.list(),
      /** For plugin routes: who's calling (from Authorization: Bearer), and what they may do. */
      auth: {
        userFrom: this.registries.userFrom,
        can,
      },
      /** Catalog rows → OpenSubsonic objects, for plugin endpoints. */
      subsonic: { ...mappers },
    }
  }

  /** Read every archive and folder in the plugins directory. Bad ones are logged and skipped. */
  async discover(): Promise<PluginArchive[]> {
    await mkdir(this.config.pluginsDir, { recursive: true })
    const archives: PluginArchive[] = []
    for (const name of (await readdir(this.config.pluginsDir)).sort()) {
      const path = join(this.config.pluginsDir, name)
      try {
        if ((await stat(path)).isDirectory()) {
          const archive = await readFolder(name, path)
          if (archive) archives.push(archive)
        } else if (/\.(noctis|zip)$/i.test(name)) {
          archives.push(readPluginArchive(name, new Uint8Array(await Bun.file(path).arrayBuffer())))
        }
      } catch (error) {
        writeLog('noctis', 'error', `Skipped ${name}:`, error)
      }
    }
    return archives
  }

  /** Load and start plugins (dependencies first). */
  async load(archives: PluginArchive[]) {
    const seen = new Set<string>()
    for (const archive of archives) {
      if (seen.has(archive.id)) {
        writeLog('noctis', 'error', `Two plugins are named "${archive.id}"; keeping the first`)
        continue
      }
      seen.add(archive.id)
      this.plugins.set(archive.id, {
        archive,
        clientSha256: archive.client !== undefined && archive.manifest.side === 'both' ? await sha256Hex(archive.client) : undefined,
        state: 'stopped',
      })
    }

    // Dependencies are checked among plugins with a server half; client-only plugins in
    // the folder are only there to be listed, not run.
    const serverSide = [...this.plugins.values()].filter((plugin) => runsOnServer(plugin.archive.manifest))
    const { order, problems } = resolveLoadOrder(serverSide.map(({ archive }) => ({ id: archive.id, manifest: archive.manifest })))
    for (const problem of problems) {
      const plugin = this.plugins.get(problem.id)!
      plugin.state = 'skipped'
      plugin.reason = describeProblem(problem)
      writeLog(problem.id, 'error', `Not started: ${plugin.reason}`)
    }
    for (const id of order) {
      // A dependency that failed to start takes its dependents down with it.
      const failed = Object.keys(this.plugins.get(id)!.archive.manifest.dependencies).find((dep) => this.plugins.get(dep)?.state !== 'running')
      if (failed) {
        const plugin = this.plugins.get(id)!
        plugin.state = 'skipped'
        plugin.reason = `${id} can't load because ${failed} didn't start`
        writeLog(id, 'error', `Not started: ${plugin.reason}`)
        continue
      }
      await this.start(id)
    }
  }

  private async start(id: string) {
    const plugin = this.plugins.get(id)!
    const { archive } = plugin
    const started = performance.now()
    try {
      const api = new ServerPluginAPI(id, this.registries, this.storage.forPlugin(id))
      const module = await this.importServerHalf(archive)
      if (typeof module.default !== 'function') throw new TypeError('server.js must `export default` a function')
      await module.default({ Plugin: api, Noctis: this.namespace() } satisfies ServerScope)
      plugin.api = api
      plugin.state = 'running'
      writeLog(id, 'info', `Started ${archive.manifest.version} in ${(performance.now() - started).toFixed(1)} ms`)
    } catch (error) {
      plugin.state = 'failed'
      plugin.reason = error instanceof Error ? error.message : String(error)
      writeLog(id, 'error', 'Failed to start:', error)
    }
  }

  /**
   * server.js is written to the cache under its hash and imported from there, so it
   * can import Node/Bun modules, and changed code is never served from a stale cache.
   */
  private async importServerHalf(archive: PluginArchive): Promise<{ default?: unknown }> {
    const hash = (await sha256Hex(archive.server ?? '')).slice(0, 16)
    const dir = join(this.config.dataDir, 'cache', 'plugins', `${archive.id}-${hash}`)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'server.mjs')
    await writeFile(file, archive.server ?? '')
    return import(file)
  }

  async disable(id: string) {
    const plugin = this.plugins.get(id)
    if (!plugin?.api || plugin.state !== 'running') return
    try {
      await plugin.api.disable()
      await plugin.api.afterDisable()
    } catch (error) {
      writeLog(id, 'error', 'disable threw:', error)
    }
    plugin.api.removeAll()
    plugin.state = 'stopped'
  }

  async enable(id: string) {
    const plugin = this.plugins.get(id)
    if (!plugin?.api || plugin.state !== 'stopped') return
    await plugin.api.enable()
    plugin.state = 'running'
  }

  async stopAll() {
    for (const id of [...this.plugins.keys()].reverse()) await this.disable(id)
  }

  /** The client halves this server wants, for running "both" plugins. */
  clientRequirements(): ClientPluginRequirement[] {
    const requirements: ClientPluginRequirement[] = []
    for (const [id, plugin] of this.plugins) {
      if (plugin.state !== 'running' || !plugin.clientSha256) continue
      const requirement = requirementFor(id, plugin.archive.manifest, plugin.clientSha256, `/noctis/v1/plugins/${id}/client.noctis`)
      if (requirement) requirements.push(requirement)
    }
    return requirements
  }

  /** The client half of a running "both" plugin, as an archive for clients to install. */
  clientArchive(id: string): Uint8Array | null {
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.state !== 'running' || plugin.archive.manifest.side !== 'both') return null
    return clientArchiveOf(plugin.archive)
  }

}

/** An unpacked plugin folder (for development): metadata.json plus its entry files. */
async function readFolder(name: string, path: string): Promise<PluginArchive | null> {
  const manifestFile = Bun.file(join(path, 'metadata.json'))
  if (!(await manifestFile.exists())) return null
  const manifest = parseManifest(await manifestFile.json())
  const read = async (file: string) => {
    const handle = Bun.file(join(path, file))
    return (await handle.exists()) ? handle.text() : undefined
  }
  // A TypeScript server half is built on the fly, bundling its npm packages.
  const buildServer = async () => {
    const entry = join(path, 'src', 'server.ts')
    if (!(await Bun.file(entry).exists())) return read('server.js')
    const result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', external: ['elysia'] })
    if (!result.success) throw new AggregateError(result.logs, `${name}: building src/server.ts failed`)
    return result.outputs[0].text()
  }
  const archive: PluginArchive = {
    id: idFromFileName(name),
    manifest,
    client: manifest.side !== 'server' ? await read('index.js') : undefined,
    server: runsOnServer(manifest) ? await buildServer() : undefined,
  }
  if (runsOnServer(manifest) && archive.server === undefined) throw new Error(`${name} has no server.js or src/server.ts`)
  if (manifest.side === 'both' && archive.client === undefined) throw new Error(`${name} has no index.js`)
  return archive
}
