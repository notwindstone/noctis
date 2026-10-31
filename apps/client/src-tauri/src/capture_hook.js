// Injected before the page's own scripts (auth.rs `capture_web_response`): watches the
// page's fetch/XHR responses and hands the first one whose URL contains MATCH out as a
// navigation to MARKER, which the app cancels and reads. __MATCH__ and __MARKER__ are
// replaced with JSON strings.
(() => {
  if (window.__noctisHook) return
  window.__noctisHook = 1
  const MATCH = __MATCH__
  const MARKER = __MARKER__
  const absolute = (url) => {
    try {
      return new URL(url, location.href).href
    } catch {
      return String(url)
    }
  }
  const send = (url, body) => {
    location.href = MARKER + '?u=' + encodeURIComponent(url) + '&b=' + encodeURIComponent(String(body))
  }

  const nativeFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await nativeFetch.apply(this, args)
    try {
      const url = absolute(typeof args[0] === 'string' ? args[0] : args[0]?.url ?? response.url)
      if (url.includes(MATCH)) send(url, await response.clone().text())
    } catch {}
    return response
  }

  const nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__noctisUrl = absolute(url)
    return nativeOpen.call(this, method, url, ...rest)
  }
  const nativeSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.__noctisUrl.includes(MATCH)) send(this.__noctisUrl, this.responseText)
      } catch {}
    })
    return nativeSend.apply(this, args)
  }
})()
