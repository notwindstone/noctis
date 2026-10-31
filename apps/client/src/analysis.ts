import { ref, shallowRef, triggerRef, type ShallowRef } from 'vue'
import { audioElement, isPlaying } from './player'

/**
 * Audio analysis: what the current song sounds like, for visualizers (the bars in a playing
 * row, a plugin's spectrum) without anyone touching the audio element.
 *
 * The audio is tapped with `captureStream()`, not `createMediaElementSource()`: the element
 * keeps playing exactly as before (the latter reroutes it through the Web Audio graph, and a
 * stream without CORS headers would then go silent). A stream the browser won't let us read
 * just yields silence here, `live` stays false, and consumers fall back to a canned animation.
 *
 * Nothing runs until something calls `use()`: no AudioContext, no frame loop. The loop also
 * sleeps while paused or while the page is hidden.
 */

const FFT_SIZE = 512
/** Band edges are spaced evenly on a log scale between these two frequencies. */
const LOW_HZ = 40
const HIGH_HZ = 14000
const DEFAULT_FPS = 30

export interface AnalysisOptions {
  /** How many frequency bands `levels` has (log-spaced, low to high). Default 3. */
  bands?: number
  /** Most updates per second. Default 30; bars don't need 60 and phones notice the difference. */
  fps?: number
}

export interface AnalysisHandle {
  /** Band levels, 0..1, low to high. A shared array that changes in place; the ref fires on every update. */
  readonly levels: Readonly<ShallowRef<Float32Array>>
  /** The raw spectrum of the latest frame (0..255 per bin, low to high), for anything finer than bands. */
  spectrum(): Uint8Array
  /** The raw waveform of the latest frame (0..255, 128 is silence), for oscilloscopes. */
  waveform(): Uint8Array
  /** Hz covered by one `spectrum()` bin. */
  readonly binHz: number
  /** Stop listening. The graph and the loop shut down with the last handle. */
  stop(): void
}

interface Consumer {
  bands: number
  interval: number
  last: number
  edges: number[]
  levels: ShallowRef<Float32Array>
}

/** True when this webview can capture an element's audio at all (not iOS's WKWebView, for one). */
export const analysisSupported = 'captureStream' in HTMLMediaElement.prototype || 'mozCaptureStream' in HTMLMediaElement.prototype
/** Real audio is flowing into the analyser (the current song has made a sound that we could read). */
export const analysisLive = ref(false)

const consumers = new Set<Consumer>()
let context: AudioContext | null = null
let analyser: AnalyserNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let spectrumData = new Uint8Array(0)
let waveformData = new Uint8Array(0)
let frame = 0
let heard = false

function bandEdges(bands: number, binHz: number, bins: number) {
  const edges: number[] = []
  for (let i = 0; i <= bands; i++) {
    const hz = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / bands)
    edges.push(Math.min(bins, Math.max(i === 0 ? 0 : edges[i - 1] + 1, Math.round(hz / binHz))))
  }
  return edges
}

/** A new song brings a new MediaStream; the old source node points at a dead one. */
function attach() {
  if (!context || !analyser) return
  source?.disconnect()
  source = null
  const element = audioElement as HTMLMediaElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
  try {
    const stream = (element.captureStream ?? element.mozCaptureStream)?.call(element)
    if (stream && stream.getAudioTracks().length > 0) {
      source = context.createMediaStreamSource(stream)
      source.connect(analyser) // not to the destination: the element already plays the sound
    }
  } catch {
    // Not capturable (cross-origin, DRM): stays silent, the canned animation covers for it.
  }
}

function ensureGraph() {
  if (context || !analysisSupported) return
  context = new AudioContext()
  analyser = context.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0.75
  spectrumData = new Uint8Array(analyser.frequencyBinCount)
  waveformData = new Uint8Array(analyser.fftSize)
  audioElement.addEventListener('loadedmetadata', attach)
  audioElement.addEventListener('playing', attach)
  attach()
}

function teardown() {
  audioElement.removeEventListener('loadedmetadata', attach)
  audioElement.removeEventListener('playing', attach)
  source?.disconnect()
  source = null
  void context?.close()
  context = null
  analyser = null
  analysisLive.value = false
  heard = false
}

function tick(now: number) {
  frame = 0
  if (consumers.size === 0) return
  if (!isPlaying.value || document.hidden || !analyser) return // restarted by `wake`

  if (context?.state === 'suspended') void context.resume().catch(() => {})
  analyser.getByteFrequencyData(spectrumData)
  analyser.getByteTimeDomainData(waveformData)

  let energy = 0
  for (let i = 0; i < spectrumData.length; i++) energy += spectrumData[i]
  if (energy > 0 && !heard) {
    heard = true
    analysisLive.value = true
  }

  const binHz = analyser.context.sampleRate / analyser.fftSize
  for (const consumer of consumers) {
    if (now - consumer.last < consumer.interval) continue
    consumer.last = now
    if (consumer.edges.length === 0) consumer.edges = bandEdges(consumer.bands, binHz, spectrumData.length)
    const levels = consumer.levels.value
    for (let band = 0; band < consumer.bands; band++) {
      const from = consumer.edges[band]
      const to = Math.max(from + 1, consumer.edges[band + 1])
      let sum = 0
      for (let bin = from; bin < to; bin++) sum += spectrumData[bin] ?? 0
      levels[band] = sum / (to - from) / 255
    }
    triggerRef(consumer.levels)
  }
  frame = requestAnimationFrame(tick)
}

function wake() {
  if (consumers.size > 0 && !frame && isPlaying.value && !document.hidden) frame = requestAnimationFrame(tick)
}

// A new song starts out "not heard": until it makes a sound we can read, bars stay canned.
audioElement.addEventListener('loadstart', () => {
  heard = false
  analysisLive.value = false
})
audioElement.addEventListener('playing', wake)
// The loop sleeps while paused; let the bars fall instead of freezing mid-air.
audioElement.addEventListener('pause', () => {
  for (const consumer of consumers) {
    consumer.levels.value.fill(0)
    triggerRef(consumer.levels)
  }
})
document.addEventListener('visibilitychange', wake)

/** Start analysing the current audio. Call `stop()` on the handle when done. */
export function useAnalysis(options: AnalysisOptions = {}): AnalysisHandle {
  const bands = Math.max(1, Math.floor(options.bands ?? 3))
  const consumer: Consumer = {
    bands,
    interval: 1000 / (options.fps ?? DEFAULT_FPS) - 2,
    last: 0,
    edges: [],
    levels: shallowRef(new Float32Array(bands)),
  }
  consumers.add(consumer)
  ensureGraph()
  wake()

  return {
    levels: consumer.levels,
    spectrum: () => spectrumData,
    waveform: () => waveformData,
    get binHz() {
      return analyser ? analyser.context.sampleRate / analyser.fftSize : 0
    },
    stop() {
      if (!consumers.delete(consumer)) return
      if (consumers.size === 0) {
        cancelAnimationFrame(frame)
        frame = 0
        teardown()
      }
    },
  }
}
