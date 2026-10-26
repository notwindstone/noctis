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

export function initOpenFiles() {
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
