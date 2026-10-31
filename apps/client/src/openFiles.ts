import { hasNoctisPlugin, Noctis } from './native'
import { writeLog } from './plugins/log'
import { installOpenedFile } from './settings/plugins'
import { notify } from './snackbar'

/**
 * Files opened with Noctis. On Android, a .noctis plugin opened from a file manager, a
 * browser's downloads or a chat app launches the app (see the intent filters in
 * AndroidManifest.xml) and installs the plugin, asking before it runs.
 */

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const isPluginFile = (file: File) => /\.(noctis|zip)$/i.test(file.name)
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * Dropping a .noctis plugin on the window installs it (desktop and browser; the Tauri window
 * has its own file drop turned off, so the webview delivers the files).
 */
function initDrop() {
  // Without preventDefault on dragover the webview would navigate to the dropped file.
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files ?? [])
    const plugins = files.filter(isPluginFile)
    if (plugins.length === 0) {
      if (files.length > 0) notify('Drop a .noctis plugin file to install it')
      return
    }
    for (const file of plugins) void file.arrayBuffer().then((bytes) => installOpenedFile(file.name, new Uint8Array(bytes)))
  })
}

export function initOpenFiles() {
  initDrop()
  if (!hasNoctisPlugin) return
  void Noctis.addListener('openFile', ({ name, data, error }) => {
    if (error || !data) {
      writeLog('noctis', 'error', `Couldn't open ${name || 'a file'}: ${error ?? 'it was empty'}`)
      notify(`Couldn't open ${name || 'the file'}: ${error ?? 'it was empty'}`)
      return
    }
    void installOpenedFile(name, base64ToBytes(data))
  })
}
