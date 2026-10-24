import { PluginBase } from '@noctis/plugin-core'
import { Elysia } from 'elysia'
import { writeLog } from '../log'
import type { ServerHookName, ServerHooks } from './hooks'
import type { PluginStore } from './storage'

/**
 * What a server plugin gets as `Plugin`: lifecycle, hooks and logging from
 * @noctis/plugin-core's PluginBase (the same as on the client), plus:
 *
 * - `routes(build)`: HTTP routes under /api/plugins/<id>/, built on an Elysia instance;
 * - `storage`: JSON key/value storage in the server's database.
 */
export class ServerPluginAPI extends PluginBase<ServerHookName> {
  readonly storage: PluginStore
  /** The plugin's router, or null without routes. Requests are forwarded to it. */
  router: Elysia | null = null

  constructor(id: string, hooks: ServerHooks, storage: PluginStore) {
    super(id, hooks, writeLog)
    this.storage = storage
  }

  /**
   * Define routes, relative to /api/plugins/<id>:
   *
   *   Plugin.routes((app) => app.get('/top', () => top()))  →  GET /api/plugins/<id>/top
   *
   * Calling it again replaces them; `removeRoutes()` takes them down (e.g. on disable).
   */
  routes(build: (app: Elysia) => Elysia) {
    this.router = build(new Elysia())
  }

  removeRoutes() {
    this.router = null
  }
}
