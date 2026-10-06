import type { Config } from './config'

/**
 * A 529 is global capacity, so every client that waits the same fixed
 * schedule comes back in the same overload window. Full jitter spreads them
 * over the whole interval; the floor keeps a retry from firing at once.
 */
const FULL_JITTER_FLOOR_MS = 5_000

export function overloadWaitMs(attempt: number, overload: Config['overload'], random: () => number): number {
  const seconds = overload.backoffSeconds[attempt] ?? overload.steadyStateSeconds
  const base = seconds * 1000
  if (overload.jitterMode === 'full') {
    return Math.max(Math.min(FULL_JITTER_FLOOR_MS, base), Math.round(random() * base))
  }
  if (overload.jitterPct === 0) return base
  const factor = 1 + (random() * 2 - 1) * (overload.jitterPct / 100)
  return Math.max(0, Math.round(base * factor))
}

/**
 * An overload retry more than this long after the last one starts a new
 * incident with a fresh budget: otherwise one bad night's attempts count
 * against an unrelated outage days later.
 */
export const INCIDENT_GAP_MS = 15 * 60_000
