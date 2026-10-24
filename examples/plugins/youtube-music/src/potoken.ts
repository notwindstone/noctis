import { BotGuardClient, getChallenge } from 'bgutils-js/botguard'
import type { WebPoSignalOutput } from 'bgutils-js/shared-types'
import { buildURL, getHeaders } from 'bgutils-js/utils'
import { WebPoMinter } from 'bgutils-js/webpo'
import { ytFetch } from './http'

/**
 * Proof-of-origin tokens for googlevideo, minted the way YouTube's web player does it:
 * load Google's BotGuard VM, take a snapshot, exchange it for an integrity token and
 * mint per-video tokens from that. The app runs inside a real Chromium WebView, so
 * BotGuard runs natively in the page; requests go through ytFetch (native HTTP on a
 * device, the Vite proxy in the browser).
 */

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'

interface MinterState {
  minter: WebPoMinter
  /** Refresh a little before the integrity token expires. */
  refreshAt: number
}

let state: Promise<MinterState> | null = null

async function createMinter(): Promise<MinterState> {
  const challenge = await getChallenge({ fetchFunction: ytFetch, requestKey: REQUEST_KEY, useYouTubeAPI: false })

  const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue
  if (!interpreter) throw new Error('BotGuard interpreter unavailable')
  if (!challenge.globalName || !(challenge.globalName in window)) {
    new Function(interpreter)()
  }

  const client = await BotGuardClient.create({
    program: challenge.program,
    globalName: challenge.globalName,
    globalObject: window,
  })

  const webPoSignalOutput: WebPoSignalOutput = []
  const botguardResponse = await client.snapshot({ webPoSignalOutput })

  const response = await ytFetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  })
  if (!response.ok) throw new Error(`Integrity token request failed (${response.status})`)
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await response.json()) as [
    string,
    number,
    number,
    string,
  ]
  if (!integrityToken) throw new Error('No integrity token')

  const minter = await WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput,
  )

  const ttl = (estimatedTtlSecs || 3600) - (mintRefreshThreshold || 600)
  return { minter, refreshAt: Date.now() + Math.max(300, ttl) * 1000 }
}

async function minter(): Promise<WebPoMinter> {
  if (state) {
    const current = await state.catch(() => null)
    if (current && Date.now() < current.refreshAt) return current.minter
  }
  state = createMinter()
  state.catch(() => {
    state = null
  })
  return (await state).minter
}

/** A content-bound token for one video, for the `pot` stream URL parameter. */
export async function poTokenFor(videoId: string): Promise<string> {
  try {
    return await (await minter()).mintAsWebsafeString(videoId)
  } catch (error) {
    // A stale VM can fail to mint; start over once.
    state = null
    return (await minter()).mintAsWebsafeString(videoId)
  }
}

/** Warm up BotGuard early so the first song doesn't wait for it. */
export function prewarmPoToken() {
  void minter().catch(() => {})
}
