import type { NoctisNamespace } from '../../../../src/plugins/namespace'

/**
 * The app, as this plugin sees it: `window.__NOCTIS__` (the same object as
 * `scopedThis.Noctis`). Everything at runtime comes from here; the build bundles only
 * this plugin's own code and npm packages ('vue' and '@capacitor/core' are the app's).
 * The types below come from the app's source and are erased at build time.
 */
export const Noctis: NoctisNamespace = window.__NOCTIS__

export type { PluginScope } from '../../../../src/plugins/runtime'
export type { SettingsBlock } from '../../../../src/plugins/rows'
export type { RadioSeed, ServiceDefinition } from '../../../../src/services/types'
export type * from '../../../../src/models'
