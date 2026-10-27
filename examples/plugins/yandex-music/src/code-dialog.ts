import { Noctis } from './host'

/**
 * The sign-in code dialog: the code in a read-only field with a Copy button, and the
 * link to open. It's a small Vue app of its own on top of the app's DialogShell (so
 * the back gesture and styling are the app's), because the app's text and choice
 * dialogs can't show read-only content, links or stay open while something else runs.
 */

const { createApp, h, ref } = Noctis.packages.vue
const { notify } = Noctis.libs.snackbar

export interface CodeDialog {
  /** Closes it (e.g. once sign-in went through). Doesn't call `onCancel`. */
  close(): void
}

export function showCodeDialog(options: { title: string; description: string; code: string; link: string; status: string; onCancel: () => void }): CodeDialog {
  const open = ref(true)
  const copied = ref(false)
  const host = document.createElement('div')
  document.body.appendChild(host)

  const close = () => {
    if (!open.value) return
    open.value = false
    // Let the leave transition play before the app goes away.
    window.setTimeout(() => {
      app.unmount()
      host.remove()
    }, 400)
  }
  const cancel = () => {
    if (!open.value) return
    close()
    options.onCancel()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(options.code)
      copied.value = true
      notify('Code copied')
    } catch {
      notify('Could not copy; select the code and copy it')
    }
  }
  const openLink = () => void window.open(options.link, '_blank')

  const app = createApp({
    setup: () => () =>
      h(
        Noctis.C.DialogShell,
        { open: open.value, title: options.title, onClose: cancel },
        {
          default: () => [
            h('p', { class: 'type-body-medium muted dialog-description' }, options.description),
            h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
              h('input', {
                class: 'text-field',
                readonly: true,
                value: options.code,
                'aria-label': 'Sign-in code',
                style: 'font:600 22px ui-monospace,monospace;letter-spacing:0.12em;text-align:center',
                onFocus: (event: FocusEvent) => (event.target as HTMLInputElement).select(),
              }),
              h('button', { class: 'tonal-button', type: 'button', onClick: copy }, copied.value ? 'Copied' : 'Copy'),
            ]),
            h(
              'a',
              {
                href: options.link,
                target: '_blank',
                rel: 'noopener',
                class: 'type-body-large',
                style: 'color:var(--md-sys-color-primary);word-break:break-all;display:flex;align-items:center;gap:6px',
                onClick: (event: MouseEvent) => {
                  event.preventDefault()
                  openLink()
                },
              },
              [h(Noctis.C.MIcon, { name: 'external', size: 18 }), options.link],
            ),
            h('p', { class: 'type-body-small muted' }, options.status),
          ],
          actions: () => [
            h('button', { class: 'text-button', type: 'button', onClick: cancel }, 'Cancel'),
            h('button', { class: 'filled-button', type: 'button', onClick: openLink }, 'Open link'),
          ],
        },
      ),
  })
  app.mount(host)
  return { close }
}
