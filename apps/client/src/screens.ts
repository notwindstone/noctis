import type { Component } from 'vue'
import type { Route } from './navigation'
import { C, type BuiltInComponentName } from './plugins/components'

/** Built-in routes and the component-registry entry that renders each. */
const SCREENS: Record<string, BuiltInComponentName> = {
  home: 'HomeScreen',
  library: 'LibraryScreen',
  settings: 'SettingsScreen',
  search: 'SearchScreen',
  album: 'AlbumScreen',
  playlist: 'PlaylistScreen',
  artist: 'ArtistScreen',
  browse: 'BrowseScreen',
  collection: 'CollectionScreen',
  'library-playlists': 'LibraryItemsScreen',
  'library-artists': 'LibraryItemsScreen',
  'settings-page': 'SettingsPageScreen',
  'downloads-queue': 'DownloadQueueScreen',
}

/**
 * The component for a route, looked up in the reactive registry so plugins can replace
 * any screen. A route name that isn't built in is looked up directly: a plugin registers
 * a component (say "LyricsScreen") and opens it with `navigate({ name: "LyricsScreen" })`.
 */
export function screenFor(route: Route): Component | undefined {
  const builtIn = SCREENS[route.name]
  return builtIn ? C[builtIn] : C[route.name]
}
