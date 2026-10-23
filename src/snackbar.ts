import { ref } from 'vue'

export const snackbarMessage = ref('')
let hideTimer: number | undefined

export function notify(message: string, duration = 3200) {
  snackbarMessage.value = message
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    snackbarMessage.value = ''
  }, duration)
}

export function dismissSnackbar() {
  window.clearTimeout(hideTimer)
  snackbarMessage.value = ''
}
