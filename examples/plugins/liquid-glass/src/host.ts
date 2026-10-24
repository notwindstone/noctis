import type { NoctisNamespace } from '../../../../apps/client/src/plugins/namespace'

/**
 * The app, as this plugin sees it (`window.__NOCTIS__`, the same object as
 * `scopedThis.Noctis`). Types come from the app's source and are erased at build time.
 */
export const Noctis: NoctisNamespace = window.__NOCTIS__

export type { PluginScope } from '../../../../apps/client/src/plugins/runtime'
