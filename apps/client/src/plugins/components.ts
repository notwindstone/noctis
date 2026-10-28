import { shallowReactive, type Component } from 'vue'
import BottomNav from '../components/BottomNav.vue'
import BottomSheet from '../components/BottomSheet.vue'
import CollectionView from '../components/CollectionView.vue'
import DialogShell from '../components/DialogShell.vue'
import ItemCard from '../components/ItemCard.vue'
import ItemRow from '../components/ItemRow.vue'
import MIcon from '../components/MIcon.vue'
import PlayerArt from '../components/PlayerArt.vue'
import PlayerSheet from '../components/PlayerSheet.vue'
import PlayFromDialog from '../components/PlayFromDialog.vue'
import QueuePanel from '../components/QueuePanel.vue'
import RefreshIndicator from '../components/RefreshIndicator.vue'
import ScreenStack from '../components/ScreenStack.vue'
import SectionView from '../components/SectionView.vue'
import SeekBar from '../components/SeekBar.vue'
import SettingsBlocks from '../components/settings/SettingsBlocks.vue'
import SettingsRow from '../components/SettingsRow.vue'
import SheetHost from '../components/SheetHost.vue'
import SnackbarHost from '../components/SnackbarHost.vue'
import StateView from '../components/StateView.vue'
import Thumb from '../components/Thumb.vue'
import TopAppBar from '../components/TopAppBar.vue'
import AlbumScreen from '../screens/AlbumScreen.vue'
import ArtistScreen from '../screens/ArtistScreen.vue'
import BrowseScreen from '../screens/BrowseScreen.vue'
import CollectionScreen from '../screens/CollectionScreen.vue'
import DownloadQueueScreen from '../screens/DownloadQueueScreen.vue'
import HomeScreen from '../screens/HomeScreen.vue'
import LibraryItemsScreen from '../screens/LibraryItemsScreen.vue'
import LibraryScreen from '../screens/LibraryScreen.vue'
import PlaylistScreen from '../screens/PlaylistScreen.vue'
import SearchScreen from '../screens/SearchScreen.vue'
import SettingsPageScreen from '../screens/SettingsPageScreen.vue'
import SettingsScreen from '../screens/SettingsScreen.vue'
import { writeLog } from './log'

/**
 * The component registry. The app renders these through `C` (`<C.PlayerSheet />`,
 * `<component :is="C.ItemRow">`), never by direct import, and `C` is reactive — so a
 * plugin replacing an entry swaps it everywhere, live, without a reload.
 *
 * Unknown names add new components; screens registered here can be opened with
 * `navigate({ name: "<ComponentName>" })`.
 */
type BuiltInComponentName =
  | 'ScreenStack'
  | 'PlayerSheet'
  | 'PlayerArt'
  | 'BottomNav'
  | 'SheetHost'
  | 'SnackbarHost'
  | 'BottomSheet'
  | 'DialogShell'
  | 'PlayFromDialog'
  | 'QueuePanel'
  | 'SeekBar'
  | 'TopAppBar'
  | 'ItemRow'
  | 'ItemCard'
  | 'SectionView'
  | 'SettingsRow'
  | 'SettingsBlocks'
  | 'CollectionView'
  | 'StateView'
  | 'RefreshIndicator'
  | 'MIcon'
  | 'Thumb'
  | 'HomeScreen'
  | 'LibraryScreen'
  | 'SettingsScreen'
  | 'SearchScreen'
  | 'AlbumScreen'
  | 'PlaylistScreen'
  | 'ArtistScreen'
  | 'BrowseScreen'
  | 'CollectionScreen'
  | 'LibraryItemsScreen'
  | 'SettingsPageScreen'
  | 'DownloadQueueScreen'

// Annotated explicitly: screens import `C` and `C` imports screens, which would otherwise
// make TypeScript's inference circular.
const BUILT_IN: Record<BuiltInComponentName, Component> = {
  // App shell
  ScreenStack,
  PlayerSheet,
  PlayerArt,
  BottomNav,
  SheetHost,
  SnackbarHost,
  // Sheets, dialogs and the player's parts
  BottomSheet,
  DialogShell,
  PlayFromDialog,
  QueuePanel,
  SeekBar,
  // Building blocks
  TopAppBar,
  ItemRow,
  ItemCard,
  SectionView,
  SettingsRow,
  SettingsBlocks,
  CollectionView,
  StateView,
  RefreshIndicator,
  MIcon,
  Thumb,
  // Screens
  HomeScreen,
  LibraryScreen,
  SettingsScreen,
  SearchScreen,
  AlbumScreen,
  PlaylistScreen,
  ArtistScreen,
  BrowseScreen,
  CollectionScreen,
  LibraryItemsScreen,
  SettingsPageScreen,
  DownloadQueueScreen,
}

export type { BuiltInComponentName }

export type ComponentRegistry = Record<string, Component> & Record<BuiltInComponentName, Component>

export const C: ComponentRegistry = shallowReactive<Record<string, Component>>({ ...BUILT_IN }) as ComponentRegistry

/** Who last registered each entry, for conflict warnings. */
const owners = new Map<string, string>(Object.keys(BUILT_IN).map((name) => [name, 'noctis']))

export function registerComponent(name: string, component: Component, owner = 'unknown') {
  const previous = owners.get(name)
  if (previous !== undefined && previous !== owner) {
    writeLog(owner, 'warn', `Replacing component "${name}" (previously provided by ${previous})`)
  }
  owners.set(name, owner)
  C[name] = component
}

/** Put back the original (built-in) component, or remove a plugin-only one. */
export function restoreComponent(name: string): boolean {
  if (name in BUILT_IN) {
    C[name] = BUILT_IN[name as BuiltInComponentName]
    owners.set(name, 'noctis')
    return true
  }
  if (!(name in C)) return false
  delete C[name]
  owners.delete(name)
  return true
}

export function componentOwner(name: string): string | undefined {
  return owners.get(name)
}
