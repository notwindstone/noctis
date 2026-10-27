import { ref } from 'vue'

/**
 * Bumped when the connection may be back: the device went online, or the app came back to
 * the foreground. Things that failed for lack of network (cover art…) watch it to try again.
 */
export const networkTick = ref(0)

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => networkTick.value++)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) networkTick.value++
  })
}
