import type { Component } from 'vue'
import type { Route } from './navigation'
import AlbumScreen from './screens/AlbumScreen.vue'
import ArtistScreen from './screens/ArtistScreen.vue'
import BrowseScreen from './screens/BrowseScreen.vue'
import CollectionScreen from './screens/CollectionScreen.vue'
import HomeScreen from './screens/HomeScreen.vue'
import LibraryItemsScreen from './screens/LibraryItemsScreen.vue'
import LibraryScreen from './screens/LibraryScreen.vue'
import PlaylistScreen from './screens/PlaylistScreen.vue'
import SearchScreen from './screens/SearchScreen.vue'
import SettingsPageScreen from './screens/SettingsPageScreen.vue'
import SettingsScreen from './screens/SettingsScreen.vue'

const SCREENS: Record<Route['name'], Component> = {
  home: HomeScreen,
  library: LibraryScreen,
  settings: SettingsScreen,
  search: SearchScreen,
  album: AlbumScreen,
  playlist: PlaylistScreen,
  artist: ArtistScreen,
  browse: BrowseScreen,
  collection: CollectionScreen,
  'library-playlists': LibraryItemsScreen,
  'library-artists': LibraryItemsScreen,
  'settings-page': SettingsPageScreen,
}

export function screenFor(route: Route): Component {
  return SCREENS[route.name]
}
