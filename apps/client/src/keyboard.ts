import { currentSong, next, previous, togglePlay } from './player'

/**
 * Keyboard shortcuts for a window with a keyboard (desktop, or a tablet with one):
 * Space plays and pauses, Ctrl+→ / Ctrl+← skip. Typing in a field, or a focused button
 * or slider, keeps its own keys.
 */
export function initKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || !currentSong.value) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return

    if (event.code === 'Space' && !event.ctrlKey && !target?.closest('button, a, [role="button"], [role="radio"]')) {
      event.preventDefault()
      void togglePlay()
    } else if (event.ctrlKey && event.key === 'ArrowRight') {
      event.preventDefault()
      next()
    } else if (event.ctrlKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      previous()
    }
  })
}
