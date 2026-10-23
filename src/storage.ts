import { ref, watch, type Ref } from 'vue'

export function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : (JSON.parse(stored) as T)
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or quota — preferences simply won't persist */
  }
}

/**
 * A ref backed by localStorage. `validate` guards against stale or hand-edited values,
 * falling back to the default instead of crashing on load.
 */
export function persisted<T>(key: string, fallback: T, validate?: (value: unknown) => boolean): Ref<T> {
  const raw = readJson<unknown>(key, fallback)
  const state = ref((validate && !validate(raw) ? fallback : raw) as T) as Ref<T>
  watch(state, (value) => writeJson(key, value), { deep: true })
  return state
}

export const oneOf =
  <T extends string>(...values: T[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && (values as string[]).includes(value)

export const isBoolean = (value: unknown) => typeof value === 'boolean'
