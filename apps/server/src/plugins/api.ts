import { PluginBase } from '@noctis/plugin-core'
import { Elysia } from 'elysia'
import type { Permissions } from '../auth'
import type { Catalog } from '../catalog/catalog'
import type { Provider, Providers, Scanner, Scanners } from '../catalog/providers'
import type { Recommender } from '../catalog/recommend'
import { writeLog } from '../log'
import type { SubsonicHandler, SubsonicRegistry } from '../subsonic/router'
import type { ServerHookName, ServerHooks } from './hooks'
import type { PluginStore } from './storage'

/** The server's registries, handed to plugins. */
export interface ServerRegistries {
  hooks: ServerHooks
  catalog: Catalog
  providers: Providers
  scanners: Scanners
  permissions: Permissions
  recommender: Recommender
  subsonic: SubsonicRegistry
}

/**
 * What a server plugin gets as `Plugin`: lifecycle, hooks and logging from
 * @noctis/plugin-core's PluginBase (the same as on the client), plus:
 *
 * - `routes(build)`: HTTP routes under /api/plugins/<id>/, on an Elysia instance;
 * - `defineProvider(id, provider)`: a source of audio (and artwork) for the catalog;
 * - `defineScanner(id, scanner)`: something startScan runs (e.g. a library);
 * - `permissions.define(name, description)`: a permission admins can grant to groups;
 * - `subsonic.endpoint(name, handler)` / `subsonic.extension(name, versions)`:
 *   OpenSubsonic extensions at /rest/<name>;
 * - `storage`: JSON key/value storage in the server's database (async).
 *
 * Registrations are attributed to the plugin; `removeAll()` (or the specific remove
 * calls) undoes them, e.g. on disable.
 */
export class ServerPluginAPI extends PluginBase<ServerHookName> {
  readonly storage: PluginStore
  /** The plugin's router, or null without routes. Requests are forwarded to it. */
  router: Elysia | null = null
  private readonly registries: ServerRegistries
  private readonly providerIds = new Set<string>()
  private readonly scannerIds = new Set<string>()

  constructor(id: string, registries: ServerRegistries, storage: PluginStore) {
    super(id, registries.hooks, writeLog)
    this.registries = registries
    this.storage = storage
  }

  /**
   * Define routes, relative to /api/plugins/<id>:
   *
   *   Plugin.routes((app) => app.get('/top', () => top()))  →  GET /api/plugins/<id>/top
   *
   * Calling it again replaces them; `removeRoutes()` takes them down.
   */
  routes(build: (app: Elysia) => Elysia) {
    this.router = build(new Elysia())
  }

  removeRoutes() {
    this.router = null
  }

  /**
   * A provider streams the catalog songs whose sources name it (see
   * src/catalog/providers.ts). Add songs with `Noctis.catalog.upsertSong({ …, source:
   * { provider: id, externalId } })`.
   */
  defineProvider(id: string, provider: Provider) {
    this.registries.providers.define(id, provider, this.id)
    this.providerIds.add(id)
  }

  removeProvider(id: string) {
    this.registries.providers.remove(id)
    this.providerIds.delete(id)
  }

  defineScanner(id: string, scanner: Scanner) {
    this.registries.scanners.define(id, scanner, this.id)
    this.scannerIds.add(id)
  }

  removeScanner(id: string) {
    this.registries.scanners.remove(id)
    this.scannerIds.delete(id)
  }

  readonly permissions = {
    /** A permission admins can grant: its name must start with "<plugin id>.". */
    define: (name: string, description: string) => this.registries.permissions.define(name, description, this.id),
  }

  readonly subsonic = {
    /** An endpoint at /rest/<name>: returns a payload object (merged into "subsonic-response") or a Response. */
    endpoint: (name: string, handler: SubsonicHandler) => this.registries.subsonic.endpoint(name, handler, this.id),
    /** List an extension in getOpenSubsonicExtensions. */
    extension: (name: string, versions: number[] = [1]) => this.registries.subsonic.extension(name, versions, this.id),
    /** Remove this plugin's endpoints and extensions. */
    remove: () => this.registries.subsonic.removeOwnedBy(this.id),
  }

  /** Undo every registration: routes, providers, scanners, OpenSubsonic endpoints, permissions. */
  removeAll() {
    this.removeRoutes()
    for (const id of [...this.providerIds]) this.removeProvider(id)
    for (const id of [...this.scannerIds]) this.removeScanner(id)
    this.subsonic.remove()
    this.registries.permissions.removeOwnedBy(this.id)
  }
}
