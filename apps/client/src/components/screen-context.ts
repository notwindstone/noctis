import { computed, inject, type InjectionKey } from 'vue'

/** Provided by ScreenStack: whether the screen with this key is the one on top. */
export const ACTIVE_KEY: InjectionKey<(key: number) => boolean> = Symbol('screen-active')

export function useScreenActive(key: () => number) {
  const isActive = inject(ACTIVE_KEY, () => true)
  return computed(() => isActive(key()))
}
