import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * Calls `load` whenever the sentinel element scrolls into view inside its screen layer.
 * Used for continuation-based infinite lists.
 */
/**
 * Calls `load` when the sentinel comes near the end of the screen. An IntersectionObserver only
 * reports when the sentinel *enters* view, so a sentinel that is already in view (the first page
 * doesn't fill a tall window, or a request was skipped while another was running) would never
 * ask again. `load` therefore says whether it added anything (`true`), and the observer is then
 * reset to look at the sentinel afresh; the returned `recheck` does the same on demand.
 */
export function useInfiniteScroll(sentinel: Ref<HTMLElement | null>, load: () => Promise<boolean | void> | boolean | void) {
  let observer: IntersectionObserver | null = null
  let busy = false

  function recheck() {
    const el = sentinel.value
    if (!observer || !el) return
    observer.unobserve(el)
    observer.observe(el)
  }

  onMounted(() => {
    const el = sentinel.value
    if (!el) return
    observer = new IntersectionObserver(
      async (entries) => {
        if (busy || !entries.some((entry) => entry.isIntersecting)) return
        busy = true
        let added: boolean | void = false
        try {
          added = await load()
        } finally {
          busy = false
        }
        if (added === true) recheck()
      },
      { root: el.closest('.screen-layer'), rootMargin: '600px 0px' },
    )
    observer.observe(el)
  })

  onBeforeUnmount(() => observer?.disconnect())

  return { recheck }
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
