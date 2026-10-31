<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useBackTarget } from '../back'

/**
 * A menu at the mouse pointer: what a right click (or ⋮ clicked with a mouse) opens on
 * a desktop, where a bottom sheet the width of a phone felt out of place. Touch keeps the
 * bottom sheet. It opens below and to the right of the point, flipping when there's no
 * room, and scrolls when it's taller than the window.
 */
const props = defineProps<{ open: boolean; at: { x: number; y: number; above?: number } | null; label?: string }>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0, origin: 'top left' })

const MARGIN = 8

function place() {
  const element = panel.value
  const at = props.at
  if (!element || !at) return
  // Layout sizes, not getBoundingClientRect: the opening animation scales the panel down.
  const width = element.offsetWidth
  const height = element.offsetHeight
  const right = at.x + width > window.innerWidth - MARGIN
  const below = at.y + height <= window.innerHeight - MARGIN || at.y < window.innerHeight / 2
  const left = right ? Math.max(MARGIN, at.x - width) : at.x
  // Opening upwards from a button: above it, not over it.
  const bottom = at.above ?? at.y
  const top = below ? Math.min(at.y, window.innerHeight - MARGIN - height) : Math.max(MARGIN, bottom - height)
  position.value = { left, top: Math.max(MARGIN, top), origin: `${below ? 'top' : 'bottom'} ${right ? 'right' : 'left'}` }
}

function items() {
  return [...(panel.value?.querySelectorAll<HTMLElement>('.context-menu-item:not(:disabled)') ?? [])]
}

/**
 * Arrow keys walk the items (wrapping around), Home/End jump. Escape is the back target's
 * (below): closing here as well let the same key press go on to leave the page.
 */
function onKeydown(event: KeyboardEvent) {
  const list = items()
  if (list.length === 0) return
  const index = list.indexOf(document.activeElement as HTMLElement)
  const go = (next: number) => {
    event.preventDefault()
    list[(next + list.length) % list.length]?.focus()
  }
  if (event.key === 'ArrowDown') go(index + 1)
  else if (event.key === 'ArrowUp') go(index < 0 ? list.length - 1 : index - 1)
  else if (event.key === 'Home') go(0)
  else if (event.key === 'End') go(list.length - 1)
  else if (event.key === 'Tab') emit('close')
}

const close = () => emit('close')

watch(
  () => [props.open, props.at] as const,
  async ([open]) => {
    window.removeEventListener('resize', close)
    window.removeEventListener('blur', close)
    if (!open) return
    await nextTick()
    place()
    // Keyboard users land on the first item; mouse users see no ring (:focus-visible).
    items()[0]?.focus({ preventScroll: true })
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', close)
  window.removeEventListener('blur', close)
})

useBackTarget({ priority: 20, enabled: () => props.open, onInvoke: close })
</script>

<template>
  <Teleport to="body">
    <Transition name="context-menu">
      <div v-if="open" class="context-menu-root" @wheel.passive="close">
        <!-- Another right click elsewhere closes this one rather than opening the browser's. -->
        <div class="context-menu-scrim" @pointerdown="close" @contextmenu.prevent="close" />
        <div
          ref="panel"
          class="context-menu"
          role="menu"
          :aria-label="label"
          :style="{ left: `${position.left}px`, top: `${position.top}px`, transformOrigin: position.origin }"
          @keydown="onKeydown"
          @contextmenu.prevent
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
