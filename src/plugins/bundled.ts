import type { PluginScope } from './runtime'
import type { InstalledPlugin } from './store'

/**
 * Plugins that ship with the app. They run through the same runtime and lifecycle as
 * installed ones (and can be disabled in Settings → Plugins), but come from the bundle
 * instead of an archive: no consent prompt, can't be removed, and not affected by the
 * "Run plugins" switch.
 */

interface BundledModule {
  default: (scope: PluginScope) => unknown
}

const LOADERS: Record<string, () => Promise<BundledModule>> = {
  'youtube-music': () => import('../services/youtube-music'),
}

export const BUNDLED_PLUGINS: InstalledPlugin[] = [
  {
    id: 'youtube-music',
    code: '',
    sha256: 'builtin:youtube-music',
    installedAt: 0,
    builtIn: true,
    metadata: {
      name: 'YouTube Music',
      version: '1.0.0',
      authors: ['Noctis'],
      type: 'unrestricted',
      description:
        'Home, search, albums, artists, radios, your library and playback from YouTube Music. Turn it off to use Noctis with other services only.',
      source: 'https://github.com/notwindstone/noctis/tree/main/src/services/youtube-music',
      categories: ['service'],
    },
  },
]

export function loadBundled(id: string): Promise<BundledModule> {
  const load = LOADERS[id]
  if (!load) return Promise.reject(new Error(`No bundled plugin "${id}"`))
  return load()
}
