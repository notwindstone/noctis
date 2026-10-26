import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { PluginPlatform } from '@noctis/plugin-core'

export interface BackEventData {
  /** 0..1, how far the user has swiped. */
  progress: number
  touchX: number
  touchY: number
  swipeEdge: 'left' | 'right'
}

export interface SystemColors {
  accent?: string
  secondary?: string
  tertiary?: string
}

export type HapticType =
  | 'tap'
  | 'press'
  | 'tick'
  | 'toggleOn'
  | 'toggleOff'
  | 'confirm'
  | 'reject'
  | 'longPress'
  | 'dragStart'
  | 'thresholdOn'
  | 'thresholdOff'
  | 'gestureEnd'

export interface MediaState {
  title: string
  artist: string
  album: string
  artwork?: string
  /** Seconds. */
  duration: number
  position: number
  playing: boolean
  hasPrevious: boolean
  hasNext: boolean
}

export interface MediaActionEvent {
  action: 'play' | 'pause' | 'next' | 'previous' | 'stop' | 'seek'
  position?: number
}

/** A file from scanMusicFolder: where it is, plus whatever tags it has. */
export interface NativeMusicFile {
  uri: string
  /** Relative to the picked folder (or, from MediaStore, to the storage volume). */
  path: string
  /** "<volume>:<path>": the same file has the same key from both scans. */
  key?: string
  mimeType: string
  size: number
  modified: number
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  track?: number
  disc?: number
  year?: number
  durationMs?: number
  bitrate?: number
  hasArtwork?: boolean
}

export interface LoginResult {
  cookie: string
  visitorData?: string
}

interface NoctisPlugin {
  setBackEnabled(options: { enabled: boolean }): Promise<void>
  getSystemColors(): Promise<SystemColors>
  openLogin(): Promise<LoginResult>
  openAuth(options: { url: string; redirect: string; title?: string }): Promise<{ url: string }>
  openCookieLogin(options: { url: string; cookieUrl: string; cookie: string; title?: string }): Promise<{ value: string; cookies: string }>
  clearCookies(options?: { url?: string }): Promise<void>
  captureResponse(options: { url: string; match: string; userAgent?: string; timeoutMs?: number }): Promise<{ url: string; body: string }>
  haptic(options: { type: HapticType }): Promise<void>
  checkMusicPermission(): Promise<{ state: string }>
  requestMusicPermission(): Promise<{ state: string }>
  scanMediaStore(): Promise<{ files: NativeMusicFile[] }>
  pickMusicFolder(): Promise<{ uri: string; name: string }>
  scanMusicFolder(options: { uri: string }): Promise<{ files: NativeMusicFile[] }>
  getLocalArtwork(options: { uri: string }): Promise<{ dataUrl: string | null }>
  releaseMusicFolder(options: { uri: string }): Promise<void>
  updateMediaSession(state: MediaState): Promise<void>
  clearMediaSession(): Promise<void>
  setKeepAwake(options: { awake: boolean }): Promise<void>
  addListener(event: 'mediaAction', handler: (data: MediaActionEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'openFile', handler: (data: { name: string; data?: string; error?: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'musicScanProgress', handler: (data: { uri: string; count: number }) => void): Promise<PluginListenerHandle>
  addListener(
    event: 'backStarted' | 'backProgressed',
    handler: (data: BackEventData) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'backCancelled' | 'backInvoked', handler: () => void): Promise<PluginListenerHandle>
}

/** Implemented in android/app/src/main/java/app/noctis/player/NoctisPlugin.java. */
export const Noctis = registerPlugin<NoctisPlugin>('Noctis')

export const isNative = Capacitor.isNativePlatform()
export const hasNoctisPlugin = isNative && Capacitor.isPluginAvailable('Noctis')

/** Which app this is, for plugins' "platforms" (metadata.json). Desktop means Tauri, once it exists. */
export const platform: PluginPlatform =
  Capacitor.getPlatform() === 'android' ? 'android' : Capacitor.getPlatform() === 'ios' ? 'ios' : '__TAURI_INTERNALS__' in window ? 'desktop' : 'web'
