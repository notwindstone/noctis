import { hasNoctisPlugin, Noctis, type HapticType } from './native'
import { hapticsEnabled } from './preferences'

export type { HapticType }

/**
 * Semantic haptics. On Android these map to the platform's HapticFeedbackConstants
 * (crisp, device-tuned, and they follow the system touch-feedback setting); elsewhere
 * they fall back to short vibrations.
 *
 * - tap: ordinary buttons       - press: play/pause and primary actions
 * - tick: tabs, chips, steps    - toggleOn / toggleOff: switches and likes
 * - confirm / reject: outcomes  - longPress, dragStart: holding something
 * - thresholdOn / thresholdOff: a drag crossing the point where releasing would act
 * - gestureEnd: a drag that completed its action
 */
const FALLBACK: Record<HapticType, number | number[]> = {
  tap: 8,
  press: 14,
  tick: 4,
  toggleOn: 10,
  toggleOff: 6,
  confirm: [10, 60, 14],
  reject: [18, 50, 18],
  longPress: 24,
  dragStart: 16,
  thresholdOn: 10,
  thresholdOff: 5,
  gestureEnd: 8,
}

export function haptic(type: HapticType = 'tap') {
  if (!hapticsEnabled.value) return

  if (hasNoctisPlugin) {
    void Noctis.haptic({ type }).catch(() => {})
    return
  }

  if (typeof navigator.vibrate === 'function') navigator.vibrate(FALLBACK[type])
}

/** Ordinary button feedback. */
export function tap() {
  haptic('tap')
}

/**
 * Tracks whether a drag is past its action threshold, firing a haptic each time it
 * crosses in either direction, the way system gestures do.
 */
export function thresholdTracker() {
  let past = false
  return {
    update(isPast: boolean) {
      if (isPast === past) return
      past = isPast
      haptic(isPast ? 'thresholdOn' : 'thresholdOff')
    },
    reset() {
      past = false
    },
  }
}
