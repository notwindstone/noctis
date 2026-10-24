import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

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

export interface LoginResult {
  cookie: string
  visitorData?: string
}

interface NoctisPlugin {
  setBackEnabled(options: { enabled: boolean }): Promise<void>
  getSystemColors(): Promise<SystemColors>
  openLogin(): Promise<LoginResult>
  openAuth(options: { url: string; redirect: string; title?: string }): Promise<{ url: string }>
  clearCookies(options?: { url?: string }): Promise<void>
  captureResponse(options: { url: string; match: string; userAgent?: string; timeoutMs?: number }): Promise<{ url: string; body: string }>
  haptic(options: { type: HapticType }): Promise<void>
  updateMediaSession(state: MediaState): Promise<void>
  clearMediaSession(): Promise<void>
  addListener(event: 'mediaAction', handler: (data: MediaActionEvent) => void): Promise<PluginListenerHandle>
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
