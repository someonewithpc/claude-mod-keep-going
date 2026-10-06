import type { Config } from './config'

export type CompactRequest = { at: number; focus: string }

export type CompactInputs = {
  now: number
  /** When the main loop's last turn ended; 0 before the first. */
  idleSince: number
  isBusy: boolean
  /** The idle period already acted on (sent, or skipped as cold). */
  handledIdleSince: number
  /** Background work the last Stop reported, monitors and shells left out; null when it said nothing. */
  background: number | null
  crons: number
  permissionAt: number
  lastSentAt: number
  lastAnswer: string
  lastMatchedAnswer: string | null
  request: CompactRequest | null
  context: { percent: number | null; tokens: number | null }
  lastUserAt: number
  cacheTtlMs: number
}

export type CompactTriggerKind = 'request' | 'policy' | 'last-message'

export type CompactDecision =
  | { action: 'none' }
  | { action: 'cold' }
  | { action: 'wait'; fireAt: number; trigger: CompactTriggerKind; focus: string }
  | { action: 'fire'; trigger: CompactTriggerKind; focus: string }

const REQUEST_MAX_AGE_MS = 24 * 3600_000
const LAST_MESSAGE = /(^|[^\w/])\/compact\b/

function minutesOfDay(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** start <= now < end in local time; 22:00-06:00 wraps past midnight. */
export function inWindow(window: Config['compact']['window'], date: Date): boolean {
  if (window === null) return true
  const now = date.getHours() * 60 + date.getMinutes()
  const start = minutesOfDay(window.start)
  const end = minutesOfDay(window.end)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

function triggerOf(c: Config['compact'], i: CompactInputs): { kind: CompactTriggerKind; focus: string } | null {
  if ((c.trigger === 'request' || c.trigger === 'both')
      && i.request !== null && i.now - i.request.at < REQUEST_MAX_AGE_MS) {
    return { kind: 'request', focus: i.request.focus || c.focus }
  }
  if (c.trigger === 'policy' || c.trigger === 'both') {
    const { percent, tokens } = i.context
    const isPercentOk = percent !== null && percent >= c.minContextPercent
    const isTokensOk = c.minContextTokens === null || (tokens !== null && tokens >= c.minContextTokens)
    if (isPercentOk && isTokensOk) return { kind: 'policy', focus: c.focus }
  }
  if (c.matchLastMessage && i.lastAnswer !== '' && i.lastAnswer !== i.lastMatchedAnswer
      && LAST_MESSAGE.test(i.lastAnswer)) {
    return { kind: 'last-message', focus: c.focus }
  }
  return null
}

/**
 * Whether this idle period should compact, and when. A compaction re-reads
 * the whole context once: done while the prompt cache is warm that read is
 * billed at the cache rate, while after expiry the next message re-sends it
 * all cold anyway. So the default fires `settle.marginSeconds` before the
 * cache expires.
 */
export function decideCompact(c: Config['compact'], i: CompactInputs): CompactDecision {
  if (!c.enabled || i.isBusy || i.idleSince === 0) return { action: 'none' }
  if (i.handledIdleSince === i.idleSince) return { action: 'none' }
  if (c.waitForAgents && (i.background === null || i.background > 0)) return { action: 'none' }
  if (i.crons > 0) return { action: 'none' }
  if (i.permissionAt > i.idleSince) return { action: 'none' }
  if (i.now - i.lastSentAt < c.minIntervalMinutes * 60_000) return { action: 'none' }

  const trigger = triggerOf(c, i)
  if (trigger === null) return { action: 'none' }
  if (!inWindow(c.window, new Date(i.now))) return { action: 'none' }
  if (c.awayMinutes !== null && i.now - i.lastUserAt < c.awayMinutes * 60_000) return { action: 'none' }

  const expiresAt = i.idleSince + i.cacheTtlMs
  if (i.now >= expiresAt) return { action: 'cold' }

  const fireAt = c.settle.mode === 'before-expiry'
    ? expiresAt - c.settle.marginSeconds * 1000
    : i.idleSince + c.settle.minutes * 60_000
  if (i.now < fireAt) return { action: 'wait', fireAt, trigger: trigger.kind, focus: trigger.focus }
  return { action: 'fire', trigger: trigger.kind, focus: trigger.focus }
}
