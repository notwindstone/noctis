import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * Calls `load` whenever the sentinel element scrolls into view inside its screen layer.
 * Used for continuation-based infinite lists.
 */
export function useInfiniteScroll(sentinel: Ref<HTMLElement | null>, load: () => Promise<void> | void) {
  let observer: IntersectionObserver | null = null
  let busy = false

  onMounted(() => {
    const el = sentinel.value
    if (!el) return
    observer = new IntersectionObserver(
      async (entries) => {
        if (busy || !entries.some((entry) => entry.isIntersecting)) return
        busy = true
        try {
          await load()
        } finally {
          busy = false
        }
      },
      { root: el.closest('.screen-layer'), rootMargin: '600px 0px' },
    )
    observer.observe(el)
  })

  onBeforeUnmount(() => observer?.disconnect())
}

/** A loading/error wrapper for async screen data. */
export function useAsync<T>(fetcher: () => Promise<T>) {
  const data = ref<T | null>(null) as Ref<T | null>
  const loading = ref(false)
  const error = ref<string | null>(null)
  let token = 0

  async function run() {
    const current = ++token
    loading.value = true
    error.value = null
    try {
      const result = await fetcher()
      if (current === token) data.value = result
    } catch (cause) {
      if (current === token) error.value = describeError(cause)
    } finally {
      if (current === token) loading.value = false
    }
  }

  return { data, loading, error, run }
}

export function describeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/failed to fetch|network|load failed|timeout|unable to resolve/i.test(message)) {
    return "You're offline or the service can't be reached."
  }
  if (/status code 401|status code 403/i.test(message)) return 'The service refused the request. Try signing in again.'
  return message.length > 160 ? `${message.slice(0, 160)}…` : message
}
