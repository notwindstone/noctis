/**
 * Material Symbols (Rounded, weight 400) used by the app. Each icon has an outlined and a
 * filled variant; the filled one is used for selected/active states, as in Material You.
 */
import { shallowReactive } from 'vue'
import i_plugin from '@material-symbols/svg-400/rounded/extension.svg?raw'
import i_pluginFill from '@material-symbols/svg-400/rounded/extension-fill.svg?raw'
import i_server from '@material-symbols/svg-400/rounded/dns.svg?raw'
import i_folder from '@material-symbols/svg-400/rounded/folder.svg?raw'
import i_folderFill from '@material-symbols/svg-400/rounded/folder-fill.svg?raw'
import i_device from '@material-symbols/svg-400/rounded/library_music.svg?raw'
import i_deviceFill from '@material-symbols/svg-400/rounded/library_music-fill.svg?raw'
import i_serverFill from '@material-symbols/svg-400/rounded/dns-fill.svg?raw'
import i_upload from '@material-symbols/svg-400/rounded/upload_file.svg?raw'
import i_uploadFill from '@material-symbols/svg-400/rounded/upload_file-fill.svg?raw'
import i_add_link from '@material-symbols/svg-400/rounded/add_link.svg?raw'
import i_add_linkFill from '@material-symbols/svg-400/rounded/add_link-fill.svg?raw'
import i_terminal from '@material-symbols/svg-400/rounded/terminal.svg?raw'
import i_terminalFill from '@material-symbols/svg-400/rounded/terminal-fill.svg?raw'
import i_fingerprint from '@material-symbols/svg-400/rounded/fingerprint.svg?raw'
import i_fingerprintFill from '@material-symbols/svg-400/rounded/fingerprint-fill.svg?raw'
import i_link from '@material-symbols/svg-400/rounded/link.svg?raw'
import i_linkFill from '@material-symbols/svg-400/rounded/link-fill.svg?raw'
import i_lockscreen from '@material-symbols/svg-400/rounded/lock.svg?raw'
import i_lockscreenFill from '@material-symbols/svg-400/rounded/lock-fill.svg?raw'
import i_home from '@material-symbols/svg-400/rounded/home.svg?raw'
import i_homeFill from '@material-symbols/svg-400/rounded/home-fill.svg?raw'
import i_library from '@material-symbols/svg-400/rounded/library_music.svg?raw'
import i_libraryFill from '@material-symbols/svg-400/rounded/library_music-fill.svg?raw'
import i_settings from '@material-symbols/svg-400/rounded/settings.svg?raw'
import i_settingsFill from '@material-symbols/svg-400/rounded/settings-fill.svg?raw'
import i_search from '@material-symbols/svg-400/rounded/search.svg?raw'
import i_searchFill from '@material-symbols/svg-400/rounded/search-fill.svg?raw'
import i_back from '@material-symbols/svg-400/rounded/arrow_back.svg?raw'
import i_backFill from '@material-symbols/svg-400/rounded/arrow_back-fill.svg?raw'
import i_close from '@material-symbols/svg-400/rounded/close.svg?raw'
import i_closeFill from '@material-symbols/svg-400/rounded/close-fill.svg?raw'
import i_play from '@material-symbols/svg-400/rounded/play_arrow.svg?raw'
import i_playFill from '@material-symbols/svg-400/rounded/play_arrow-fill.svg?raw'
import i_pause from '@material-symbols/svg-400/rounded/pause.svg?raw'
import i_pauseFill from '@material-symbols/svg-400/rounded/pause-fill.svg?raw'
import i_previous from '@material-symbols/svg-400/rounded/skip_previous.svg?raw'
import i_previousFill from '@material-symbols/svg-400/rounded/skip_previous-fill.svg?raw'
import i_next from '@material-symbols/svg-400/rounded/skip_next.svg?raw'
import i_nextFill from '@material-symbols/svg-400/rounded/skip_next-fill.svg?raw'
import i_shuffle from '@material-symbols/svg-400/rounded/shuffle.svg?raw'
import i_shuffleFill from '@material-symbols/svg-400/rounded/shuffle-fill.svg?raw'
import i_repeat from '@material-symbols/svg-400/rounded/repeat.svg?raw'
import i_repeatFill from '@material-symbols/svg-400/rounded/repeat-fill.svg?raw'
import i_repeat_one from '@material-symbols/svg-400/rounded/repeat_one.svg?raw'
import i_repeat_oneFill from '@material-symbols/svg-400/rounded/repeat_one-fill.svg?raw'
import i_favorite from '@material-symbols/svg-400/rounded/favorite.svg?raw'
import i_favoriteFill from '@material-symbols/svg-400/rounded/favorite-fill.svg?raw'
import i_download from '@material-symbols/svg-400/rounded/download.svg?raw'
import i_downloadFill from '@material-symbols/svg-400/rounded/download-fill.svg?raw'
import i_downloaded from '@material-symbols/svg-400/rounded/download_done.svg?raw'
import i_downloadedFill from '@material-symbols/svg-400/rounded/download_done-fill.svg?raw'
import i_downloading from '@material-symbols/svg-400/rounded/downloading.svg?raw'
import i_downloadingFill from '@material-symbols/svg-400/rounded/downloading-fill.svg?raw'
import i_history from '@material-symbols/svg-400/rounded/history.svg?raw'
import i_historyFill from '@material-symbols/svg-400/rounded/history-fill.svg?raw'
import i_cached from '@material-symbols/svg-400/rounded/cached.svg?raw'
import i_cachedFill from '@material-symbols/svg-400/rounded/cached-fill.svg?raw'
import i_more from '@material-symbols/svg-400/rounded/more_vert.svg?raw'
import i_moreFill from '@material-symbols/svg-400/rounded/more_vert-fill.svg?raw'
import i_queue from '@material-symbols/svg-400/rounded/queue_music.svg?raw'
import i_queueFill from '@material-symbols/svg-400/rounded/queue_music-fill.svg?raw'
import i_playlist from '@material-symbols/svg-400/rounded/playlist_play.svg?raw'
import i_playlistFill from '@material-symbols/svg-400/rounded/playlist_play-fill.svg?raw'
import i_playlist_add from '@material-symbols/svg-400/rounded/playlist_add.svg?raw'
import i_playlist_addFill from '@material-symbols/svg-400/rounded/playlist_add-fill.svg?raw'
import i_collapse from '@material-symbols/svg-400/rounded/keyboard_arrow_down.svg?raw'
import i_collapseFill from '@material-symbols/svg-400/rounded/keyboard_arrow_down-fill.svg?raw'
import i_account from '@material-symbols/svg-400/rounded/account_circle.svg?raw'
import i_accountFill from '@material-symbols/svg-400/rounded/account_circle-fill.svg?raw'
import i_person from '@material-symbols/svg-400/rounded/person.svg?raw'
import i_personFill from '@material-symbols/svg-400/rounded/person-fill.svg?raw'
import i_palette from '@material-symbols/svg-400/rounded/palette.svg?raw'
import i_paletteFill from '@material-symbols/svg-400/rounded/palette-fill.svg?raw'
import i_dark from '@material-symbols/svg-400/rounded/dark_mode.svg?raw'
import i_darkFill from '@material-symbols/svg-400/rounded/dark_mode-fill.svg?raw'
import i_light from '@material-symbols/svg-400/rounded/light_mode.svg?raw'
import i_lightFill from '@material-symbols/svg-400/rounded/light_mode-fill.svg?raw'
import i_auto from '@material-symbols/svg-400/rounded/brightness_auto.svg?raw'
import i_autoFill from '@material-symbols/svg-400/rounded/brightness_auto-fill.svg?raw'
import i_contrast from '@material-symbols/svg-400/rounded/contrast.svg?raw'
import i_contrastFill from '@material-symbols/svg-400/rounded/contrast-fill.svg?raw'
import i_equalizer from '@material-symbols/svg-400/rounded/graphic_eq.svg?raw'
import i_equalizerFill from '@material-symbols/svg-400/rounded/graphic_eq-fill.svg?raw'
import i_storage from '@material-symbols/svg-400/rounded/storage.svg?raw'
import i_storageFill from '@material-symbols/svg-400/rounded/storage-fill.svg?raw'
import i_info from '@material-symbols/svg-400/rounded/info.svg?raw'
import i_infoFill from '@material-symbols/svg-400/rounded/info-fill.svg?raw'
import i_language from '@material-symbols/svg-400/rounded/language.svg?raw'
import i_languageFill from '@material-symbols/svg-400/rounded/language-fill.svg?raw'
import i_delete from '@material-symbols/svg-400/rounded/delete.svg?raw'
import i_deleteFill from '@material-symbols/svg-400/rounded/delete-fill.svg?raw'
import i_logout from '@material-symbols/svg-400/rounded/logout.svg?raw'
import i_logoutFill from '@material-symbols/svg-400/rounded/logout-fill.svg?raw'
import i_login from '@material-symbols/svg-400/rounded/login.svg?raw'
import i_loginFill from '@material-symbols/svg-400/rounded/login-fill.svg?raw'
import i_radio from '@material-symbols/svg-400/rounded/sensors.svg?raw'
import i_radioFill from '@material-symbols/svg-400/rounded/sensors-fill.svg?raw'
import i_album from '@material-symbols/svg-400/rounded/album.svg?raw'
import i_albumFill from '@material-symbols/svg-400/rounded/album-fill.svg?raw'
import i_artist from '@material-symbols/svg-400/rounded/artist.svg?raw'
import i_artistFill from '@material-symbols/svg-400/rounded/artist-fill.svg?raw'
import i_refresh from '@material-symbols/svg-400/rounded/refresh.svg?raw'
import i_refreshFill from '@material-symbols/svg-400/rounded/refresh-fill.svg?raw'
import i_check from '@material-symbols/svg-400/rounded/check.svg?raw'
import i_checkFill from '@material-symbols/svg-400/rounded/check-fill.svg?raw'
import i_chevron_right from '@material-symbols/svg-400/rounded/chevron_right.svg?raw'
import i_chevron_rightFill from '@material-symbols/svg-400/rounded/chevron_right-fill.svg?raw'
import i_suggest from '@material-symbols/svg-400/rounded/north_west.svg?raw'
import i_suggestFill from '@material-symbols/svg-400/rounded/north_west-fill.svg?raw'
import i_music from '@material-symbols/svg-400/rounded/music_note.svg?raw'
import i_musicFill from '@material-symbols/svg-400/rounded/music_note-fill.svg?raw'
import i_wallpaper from '@material-symbols/svg-400/rounded/wallpaper.svg?raw'
import i_wallpaperFill from '@material-symbols/svg-400/rounded/wallpaper-fill.svg?raw'
import i_quality from '@material-symbols/svg-400/rounded/high_quality.svg?raw'
import i_qualityFill from '@material-symbols/svg-400/rounded/high_quality-fill.svg?raw'
import i_offline from '@material-symbols/svg-400/rounded/cloud_off.svg?raw'
import i_offlineFill from '@material-symbols/svg-400/rounded/cloud_off-fill.svg?raw'
import i_error from '@material-symbols/svg-400/rounded/error.svg?raw'
import i_errorFill from '@material-symbols/svg-400/rounded/error-fill.svg?raw'
import i_external from '@material-symbols/svg-400/rounded/open_in_new.svg?raw'
import i_externalFill from '@material-symbols/svg-400/rounded/open_in_new-fill.svg?raw'
import i_cookie from '@material-symbols/svg-400/rounded/cookie.svg?raw'
import i_cookieFill from '@material-symbols/svg-400/rounded/cookie-fill.svg?raw'
import i_explicit from '@material-symbols/svg-400/rounded/explicit.svg?raw'
import i_explicitFill from '@material-symbols/svg-400/rounded/explicit-fill.svg?raw'
import i_play_next from '@material-symbols/svg-400/rounded/queue_play_next.svg?raw'
import i_play_nextFill from '@material-symbols/svg-400/rounded/queue_play_next-fill.svg?raw'
import i_add_queue from '@material-symbols/svg-400/rounded/add_to_queue.svg?raw'
import i_add_queueFill from '@material-symbols/svg-400/rounded/add_to_queue-fill.svg?raw'
import i_schedule from '@material-symbols/svg-400/rounded/schedule.svg?raw'
import i_scheduleFill from '@material-symbols/svg-400/rounded/schedule-fill.svg?raw'
import i_warning from '@material-symbols/svg-400/rounded/warning.svg?raw'
import i_warningFill from '@material-symbols/svg-400/rounded/warning-fill.svg?raw'
import i_drag from '@material-symbols/svg-400/rounded/drag_handle.svg?raw'
import i_dragFill from '@material-symbols/svg-400/rounded/drag_handle-fill.svg?raw'
import i_tune from '@material-symbols/svg-400/rounded/tune.svg?raw'
import i_tuneFill from '@material-symbols/svg-400/rounded/tune-fill.svg?raw'
import i_lyrics from '@material-symbols/svg-400/rounded/lyrics.svg?raw'
import i_lyricsFill from '@material-symbols/svg-400/rounded/lyrics-fill.svg?raw'
import i_share from '@material-symbols/svg-400/rounded/share.svg?raw'
import i_shareFill from '@material-symbols/svg-400/rounded/share-fill.svg?raw'
import i_code from '@material-symbols/svg-400/rounded/code.svg?raw'
import i_codeFill from '@material-symbols/svg-400/rounded/code-fill.svg?raw'
import i_sync from '@material-symbols/svg-400/rounded/sync.svg?raw'
import i_syncFill from '@material-symbols/svg-400/rounded/sync-fill.svg?raw'
import i_manage_account from '@material-symbols/svg-400/rounded/manage_accounts.svg?raw'
import i_manage_accountFill from '@material-symbols/svg-400/rounded/manage_accounts-fill.svg?raw'
import i_image from '@material-symbols/svg-400/rounded/imagesmode.svg?raw'
import i_imageFill from '@material-symbols/svg-400/rounded/imagesmode-fill.svg?raw'
import i_paint from '@material-symbols/svg-400/rounded/format_paint.svg?raw'
import i_paintFill from '@material-symbols/svg-400/rounded/format_paint-fill.svg?raw'
import i_vibrate from '@material-symbols/svg-400/rounded/swipe_down.svg?raw'
import i_vibrateFill from '@material-symbols/svg-400/rounded/swipe_down-fill.svg?raw'
import i_list from '@material-symbols/svg-400/rounded/format_list_bulleted.svg?raw'
import i_listFill from '@material-symbols/svg-400/rounded/format_list_bulleted-fill.svg?raw'

const RAW = {
  'home': [i_home, i_homeFill],
  'plugin': [i_plugin, i_pluginFill],
  'server': [i_server, i_serverFill],
  'folder': [i_folder, i_folderFill],
  'device-music': [i_device, i_deviceFill],
  'upload': [i_upload, i_uploadFill],
  'add-link': [i_add_link, i_add_linkFill],
  'terminal': [i_terminal, i_terminalFill],
  'fingerprint': [i_fingerprint, i_fingerprintFill],
  'link': [i_link, i_linkFill],
  'lockscreen': [i_lockscreen, i_lockscreenFill],
  'library': [i_library, i_libraryFill],
  'settings': [i_settings, i_settingsFill],
  'search': [i_search, i_searchFill],
  'back': [i_back, i_backFill],
  'close': [i_close, i_closeFill],
  'play': [i_play, i_playFill],
  'pause': [i_pause, i_pauseFill],
  'previous': [i_previous, i_previousFill],
  'next': [i_next, i_nextFill],
  'shuffle': [i_shuffle, i_shuffleFill],
  'repeat': [i_repeat, i_repeatFill],
  'repeat-one': [i_repeat_one, i_repeat_oneFill],
  'favorite': [i_favorite, i_favoriteFill],
  'download': [i_download, i_downloadFill],
  'downloaded': [i_downloaded, i_downloadedFill],
  'downloading': [i_downloading, i_downloadingFill],
  'history': [i_history, i_historyFill],
  'cached': [i_cached, i_cachedFill],
  'more': [i_more, i_moreFill],
  'queue': [i_queue, i_queueFill],
  'playlist': [i_playlist, i_playlistFill],
  'playlist-add': [i_playlist_add, i_playlist_addFill],
  'collapse': [i_collapse, i_collapseFill],
  'account': [i_account, i_accountFill],
  'person': [i_person, i_personFill],
  'palette': [i_palette, i_paletteFill],
  'dark': [i_dark, i_darkFill],
  'light': [i_light, i_lightFill],
  'auto': [i_auto, i_autoFill],
  'contrast': [i_contrast, i_contrastFill],
  'equalizer': [i_equalizer, i_equalizerFill],
  'storage': [i_storage, i_storageFill],
  'info': [i_info, i_infoFill],
  'language': [i_language, i_languageFill],
  'delete': [i_delete, i_deleteFill],
  'logout': [i_logout, i_logoutFill],
  'login': [i_login, i_loginFill],
  'radio': [i_radio, i_radioFill],
  'album': [i_album, i_albumFill],
  'artist': [i_artist, i_artistFill],
  'refresh': [i_refresh, i_refreshFill],
  'check': [i_check, i_checkFill],
  'chevron-right': [i_chevron_right, i_chevron_rightFill],
  'suggest': [i_suggest, i_suggestFill],
  'music': [i_music, i_musicFill],
  'wallpaper': [i_wallpaper, i_wallpaperFill],
  'quality': [i_quality, i_qualityFill],
  'offline': [i_offline, i_offlineFill],
  'error': [i_error, i_errorFill],
  'external': [i_external, i_externalFill],
  'cookie': [i_cookie, i_cookieFill],
  'explicit': [i_explicit, i_explicitFill],
  'play-next': [i_play_next, i_play_nextFill],
  'add-queue': [i_add_queue, i_add_queueFill],
  'schedule': [i_schedule, i_scheduleFill],
  'warning': [i_warning, i_warningFill],
  'drag': [i_drag, i_dragFill],
  'tune': [i_tune, i_tuneFill],
  'lyrics': [i_lyrics, i_lyricsFill],
  'share': [i_share, i_shareFill],
  'code': [i_code, i_codeFill],
  'sync': [i_sync, i_syncFill],
  'manage-account': [i_manage_account, i_manage_accountFill],
  'image': [i_image, i_imageFill],
  'paint': [i_paint, i_paintFill],
  'vibrate': [i_vibrate, i_vibrateFill],
  'list': [i_list, i_listFill],
} as const

export type IconName = keyof typeof RAW

function pathOf(svg: string): string {
  return /\sd="([^"]+)"/.exec(svg)?.[1] ?? ''
}

/** viewBox of every Material Symbols SVG. */
export const ICON_VIEWBOX = '0 -960 960 960'

export interface IconPaths {
  outlined: string
  filled: string
}

/** Reactive, so icons registered by plugins render as soon as they're added. */
export const ICONS = shallowReactive(
  Object.fromEntries(
    Object.entries(RAW).map(([name, [outlined, filled]]) => [name, { outlined: pathOf(outlined), filled: pathOf(filled) }]),
  ) as Record<string, IconPaths>,
)

/**
 * Add an icon. Paths are SVG path data in the Material Symbols viewBox
 * (`0 -960 960 960`); the filled variant defaults to the outlined one.
 */
export function registerIcon(name: string, outlined: string, filled = outlined) {
  ICONS[name] = { outlined, filled }
}
