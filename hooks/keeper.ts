import type { SessionRateLimit } from 'claude-code'

import { overloadWaitMs, INCIDENT_GAP_MS } from './backoff'
import { classify, type Failure } from './classify'
import { decideCompact } from './compact'
import { DEFAULTS, type Config } from './config'
import { parseResetTime, calculateWaitMs } from './lib/time-parser.js'
import { viewOf, clockOf, durationOf } from './view'
import type { KeepGoingCore, KeepGoingRetryFamily, KeepGoingView } from '../types'

/**
 * What the keeper needs from the engine, as closures the hooks module builds
 * inside its session.start hook (a module may only spell `$` at a call site).
 */
export type Io = {
  now: () => Promise<number>
  saveState: (core: KeepGoingCore, view: KeepGoingView | null) => Promise<void>
  loadCore: () => Promise<KeepGoingCore | null | undefined>
  status: (text: string | undefined) => void
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeKeys: () => Promise<string[]>
  storeDelete: (key: string) => Promise<void>
  rateLimits: () => Promise<readonly SessionRateLimit[]>
  context: () => Promise<{ percent: number | null; tokens: number | null; isSubscription: boolean }>
  model: () => Promise<string>
  lastAssistantText: () => Promise<string>
  /** Subagents still working: pending or running, not a teammate sitting idle. */
  busyAgents: () => Promise<number>
  submit: (text: string) => Promise<void>
  compact: (focus: string) => Promise<string | null>
  isReachable: (url: string, timeoutMs: number) => Promise<boolean>
  after: (ms: number, fn: () => void) => void
}

const STORE_MAX_AGE_MS = 8 * 24 * 3600_000
const USAGE_RECHECK_MS = 30_000
const NETWORK_RECHECK_MS = 15_000
const NETWORK_TIMEOUT_MS = 5_000
const FAILURE_SETTLE_MS = 1_500
const WRAP_UP_DELAY_MS = 2_000

/** Background tasks that run for the whole session and end without a Stop. */
const LONG_LIVED_TASKS = new Set(['monitor', 'shell'])

/** Prompts that mean the person is at the keyboard (or on their phone). */
const PERSON_ORIGINS = new Set(['composer', 'bridge'])

export function freshCore(): KeepGoingCore {
  return {
    usage: null,
    retry: null,
    fallback: null,
    wrapUp: { noticeAt: 0, dueAt: 0, nudges: 0 },
    compact: {
      request: null,
      lastSentAt: 0,
      handledIdleSince: 0,
      lastMatchedAnswer: null,
      scheduledFor: 0,
      reportedIdleSince: 0,
    },
    activity: {
      isBusy: false,
      turnStartedAt: 0,
      idleSince: 0,
      lastUserAt: 0,
      background: null,
      crons: 0,
      permissionAt: 0,
      lastAnswer: '',
      failureTurnStartedAt: -1,
    },
    isPaused: false,
    cacheTtlMs: null,
  }
}

export type Logger = {
  info: (line: string) => void
  warn: (line: string) => void
  /** A line in the transcript too, for what the person should see happen. */
  notice: (line: string) => void
}

/**
 * Everything the mod knows and does. Events record facts and set deadlines
 * (a hook has a ten-second budget, so none of them waits); one timer reads
 * the clock and acts on the deadlines. Comparing against the clock each tick
 * also covers suspend: a wait that ran out while the laptop slept fires on
 * the first tick after it wakes.
 */
export class Keeper {
  core: KeepGoingCore = freshCore()
  config: Config = DEFAULTS
  sessionId = ''
  random: () => number = Math.random
  private isTicking = false
  private lastView = ''

  io!: Io

  constructor(readonly log: Logger) {}

  async save(): Promise<void> {
    const now = await this.io.now()
    const view = viewOf(this.core, this.config, now)
    const viewKey = JSON.stringify(view)
    const isNewView = viewKey !== this.lastView
    this.lastView = viewKey
    await this.io.saveState(this.core, isNewView ? view : null)
    if (isNewView) this.showStatus(view)
    if (this.sessionId !== '') {
      await this.io.storeSet(`session:${this.sessionId}`, {
        savedAt: now,
        usage: this.core.usage,
        fallback: this.core.fallback,
      })
    }
  }

  private showStatus(view: KeepGoingView): void {
    if (this.config.ui.statusLine === 'off') return
    const isOnBand = this.config.ui.band && view.actions.length > 0
    this.io.status(view.line === null || isOnBand ? undefined : `keep-going: ${view.line}`)
  }

  async restore(sessionId: string): Promise<void> {
    this.sessionId = sessionId
    const held = await this.io.loadCore()
    if (held) {
      this.core = { ...freshCore(), ...held }
      return
    }
    const saved = await this.io.storeGet(`session:${sessionId}`)
    if (typeof saved !== 'object' || saved === null) return
    const { savedAt, usage, fallback } = saved as Partial<{ savedAt: number; usage: KeepGoingCore['usage']; fallback: KeepGoingCore['fallback'] }>
    const now = await this.io.now()
    if (typeof savedAt !== 'number' || now - savedAt > STORE_MAX_AGE_MS) return
    this.core.usage = usage ?? null
    this.core.fallback = fallback ?? null
    if (this.core.usage !== null) this.log.info('picked up the usage wait from before the restart')
  }

  /** Drops this mod's store entries that are more than eight days old. */
  async sweepStore(): Promise<void> {
    const now = await this.io.now()
    for (const key of await this.io.storeKeys()) {
      if (!key.startsWith('session:')) continue
      const value = await this.io.storeGet(key)
      const savedAt = typeof value === 'object' && value !== null ? (value as { savedAt?: unknown }).savedAt : undefined
      if (typeof savedAt !== 'number' || now - savedAt > STORE_MAX_AGE_MS) await this.io.storeDelete(key)
    }
  }

  // Events

  async onTurnStart(): Promise<void> {
    const a = this.core.activity
    a.isBusy = true
    a.turnStartedAt = await this.io.now()
    if (this.core.usage !== null) this.core.usage.submittedAt = 0
    await this.save()
  }

  async onTurnComplete(reason: string, answer: string): Promise<void> {
    const now = await this.io.now()
    const a = this.core.activity
    a.isBusy = false
    a.idleSince = now
    a.lastAnswer = answer

    if (reason === 'answer') {
      this.onAnswered(now)
    } else if (reason === 'aborted') {
      if (this.core.usage !== null || this.core.retry !== null) {
        this.log.info('turn interrupted, dropping the pending continue (user-interrupted)')
        this.core.usage = null
        this.core.retry = null
      }
    } else if (reason === 'refusal') {
      await this.onFailure({ kind: 'safeguard', text: answer })
    } else if (reason === 'error') {
      const turnStartedAt = a.turnStartedAt
      this.io.after(FAILURE_SETTLE_MS, () => {
        void this.classifyLate(turnStartedAt, answer)
      })
    }
    await this.save()
  }

  private onAnswered(now: number): void {
    const u = this.core.usage
    if (u !== null) {
      const how = u.nativeNotice === 'fired' && u.attempts === 0 ? 'native-resumed' : 'resumed'
      this.log.notice(`usage limit over, the session is working again (${how})`)
      this.core.usage = null
    }
    const r = this.core.retry
    if (r !== null) {
      this.log.info(`${r.family} recovered after ${r.attempts} retries`)
      this.core.retry = null
    }
    const f = this.core.fallback
    if (f !== null && f.phase === 'continue') f.phase = 'active'

    const w = this.core.wrapUp
    const a = this.core.activity
    if (w.noticeAt >= a.turnStartedAt && w.noticeAt !== 0) {
      if (this.config.nearLimitWrapUp.enabled && w.nudges < this.config.nearLimitWrapUp.maxRetries) {
        w.dueAt = now + WRAP_UP_DELAY_MS
      } else if (w.nudges >= this.config.nearLimitWrapUp.maxRetries) {
        this.log.warn('wrap-up nudge: gave up')
      }
    } else {
      w.nudges = 0
      w.dueAt = 0
    }
  }

  /**
   * A turn that ended in an error when no StopFailure reached us for it: the
   * classic event only fires while some hook is registered for it, so this
   * reads the error message the turn ended on instead.
   */
  private async classifyLate(turnStartedAt: number, answer: string): Promise<void> {
    if (this.core.activity.failureTurnStartedAt === turnStartedAt) return
    let text = answer
    if (text === '') {
      text = await this.io.lastAssistantText()
    }
    const failure = classify(null, text, this.config.customPatterns)
    if (failure === null) {
      this.log.info(`turn ended in an error that retrying won't fix: ${text.slice(0, 200)}`)
      return
    }
    await this.onFailure(failure)
    await this.save()
  }

  async onStopFailure(error: string, text: string): Promise<void> {
    this.log.info(`StopFailure: ${error}`)
    const failure = classify(error, text, this.config.customPatterns)
    if (failure === null) {
      this.log.info(`StopFailure ${error}: not retryable`)
      return
    }
    await this.onFailure(failure)
    await this.save()
  }

  async onFailure(failure: Failure): Promise<void> {
    const a = this.core.activity
    if (a.failureTurnStartedAt === a.turnStartedAt) return
    a.failureTurnStartedAt = a.turnStartedAt
    const now = await this.io.now()
    this.log.info(`failure: ${failure.kind}: ${failure.text.slice(0, 300)}`)

    if (failure.kind === 'usage') {
      if (failure.model !== null && await this.startFallback(failure.model, failure.text, now)) return
      await this.enterUsageWait(failure.text, now)
      return
    }
    if (this.core.usage !== null) return
    this.retryFailure(failure.kind, failure.text, now)
  }

  private async resetFromRateLimits(): Promise<number | null> {
    const rateLimits = await this.io.rateLimits()
    const resets = rateLimits
      .filter((w) => w.percentUsed >= 100 && w.resetsAt !== undefined)
      .map((w) => Date.parse(w.resetsAt ?? ''))
      .filter((t) => Number.isFinite(t))
    return resets.length > 0 ? Math.max(...resets) : null
  }

  private async enterUsageWait(banner: string, now: number): Promise<void> {
    const margin = this.config.marginSeconds * 1000
    let until: number
    let isFallback = false
    const fromApi = await this.resetFromRateLimits()
    const parsed = parseResetTime(banner)
    if (fromApi !== null && fromApi > now - 3600_000) {
      until = Math.max(now, fromApi) + margin
    } else if (parsed !== null) {
      until = now + calculateWaitMs(parsed, this.config.marginSeconds, this.config.fallbackWaitHours, new Date(now))
    } else {
      until = now + this.config.fallbackWaitHours * 3600_000 + margin
      isFallback = true
    }

    this.core.retry = null
    const u = this.core.usage
    if (u !== null) {
      u.until = until
      u.isFallback = isFallback
      u.banner = banner
      u.submittedAt = 0
    } else {
      this.core.usage = {
        until,
        enteredAt: now,
        isFallback,
        attempts: 0,
        banner,
        submittedAt: 0,
        nativeNotice: null,
        nativeNoticeAt: 0,
        hasLoggedGrace: false,
        hasLoggedMissed: false,
        networkDownSince: 0,
        isGivenUp: false,
      }
    }
    const source = fromApi !== null ? 'the API' : parsed !== null ? 'the banner' : 'no reset time, the fallback wait'
    this.log.notice(`usage limit: continuing at ${clockOf(until)}, in ${durationOf(until - now)} (from ${source})`)
  }

  /** A wait taken from `fallbackWaitHours` moves to the real reset once one is known. */
  async onMeasure(): Promise<void> {
    const u = this.core.usage
    if (u === null || !u.isFallback) return
    const reset = await this.resetFromRateLimits()
    if (reset === null) return
    u.until = reset + this.config.marginSeconds * 1000
    u.isFallback = false
    this.log.info(`usage wait corrected to ${clockOf(u.until)} from the rate-limit windows`)
    await this.save()
  }

  private retryFailure(family: KeepGoingRetryFamily, detail: string, now: number): void {
    const cfg = family === 'overload' ? this.config.overload
      : family === 'safeguard' ? this.config.safeguard
        : this.config.streamInterrupted
    if (!cfg.enabled) {
      this.log.info(`${family}: retry turned off`)
      return
    }
    let r = this.core.retry
    const isNewIncident = r === null || r.family !== family
      || (family === 'overload' && r.lastSentAt !== 0 && now - r.lastSentAt > INCIDENT_GAP_MS)
    if (r === null || isNewIncident) {
      r = { family, attempts: 0, until: 0, startedAt: now, totalWaitMs: 0, lastSentAt: 0, isAwaitingResult: false, isGivenUp: false, detail }
      this.core.retry = r
    }
    r.detail = detail
    r.isAwaitingResult = false

    const max = family === 'overload' ? this.config.maxRetries : (cfg as Config['safeguard']).maxRetries
    if (r.attempts >= max) {
      if (!r.isGivenUp) this.log.notice(`${family}: gave up after ${r.attempts} retries`)
      r.isGivenUp = true
      return
    }
    const wait = family === 'overload'
      ? overloadWaitMs(r.attempts, this.config.overload, this.random)
      : (cfg as Config['safeguard']).retryDelaySeconds * 1000
    if (family === 'overload' && r.totalWaitMs + wait > this.config.overload.maxTotalWaitMinutes * 60_000) {
      if (!r.isGivenUp) this.log.notice(`overload: gave up, ${Math.round(r.totalWaitMs / 60_000)} minutes of waiting already`)
      r.isGivenUp = true
      return
    }
    r.totalWaitMs += wait
    r.until = now + wait
    this.log.info(`${family}: retry ${r.attempts + 1} in ${durationOf(wait)}`)
  }

  private async startFallback(model: string, banner: string, now: number): Promise<boolean> {
    const mf = this.config.modelFallback
    if (!mf.enabled) return false
    const key = Object.keys(mf.map).find((k) => k.toLowerCase() === model.toLowerCase())
    const alias = key === undefined ? undefined : mf.map[key]
    if (alias === undefined) return false
    const f = this.core.fallback
    if (f !== null && f.from.toLowerCase() === model.toLowerCase()) return false
    const parsed = parseResetTime(banner)
    const resetAt = parsed !== null
      ? now + calculateWaitMs(parsed, this.config.marginSeconds, this.config.fallbackWaitHours, new Date(now))
      : now + this.config.fallbackWaitHours * 3600_000
    const to = modelIdOf(alias)
    this.core.fallback = { from: model, to, original: await this.io.model(), resetAt, phase: 'switch' }
    this.core.retry = null
    this.log.notice(`${model} limit: sending its requests to ${to} until ${clockOf(resetAt)}`)
    return true
  }

  /**
   * The model a request should go to: the fallback while one model's limit
   * holds, for the main loop and subagents alike. Rewriting each request
   * leaves /model and the saved default alone, which a /model switch would
   * not: it saves the model as the default for new sessions.
   */
  stepModel(model: string, now: number): string | null {
    const f = this.core.fallback
    if (f === null || f.phase === 'restore' || now >= f.resetAt) return null
    return model.toLowerCase().includes(f.from.toLowerCase()) ? f.to : null
  }

  onNotification(now: number, type: string): void {
    if (type === 'permission_prompt') this.core.activity.permissionAt = now
    const u = this.core.usage
    if (u === null) return
    const notice = type === 'quota_auto_resume_fired' ? 'fired'
      : type === 'quota_auto_resume_stale' ? 'stale'
        : type === 'quota_auto_resume_disabled' ? 'disabled' : null
    if (notice === null) return
    u.nativeNotice = notice
    u.nativeNoticeAt = now
    this.log.info(`Claude Code auto-continue: ${notice}`)
  }

  onStop(background: number | null, crons: number): void {
    this.core.activity.background = background
    this.core.activity.crons = crons
  }

  async onPersonPrompt(): Promise<void> {
    const now = await this.io.now()
    this.core.activity.lastUserAt = now
    const a = this.core.activity
    if (!a.isBusy && (this.core.usage !== null || this.core.retry !== null)) {
      this.log.info('the person sent a prompt, dropping the pending continue (user-continued)')
      this.core.usage = null
      this.core.retry = null
    }
    this.core.wrapUp.dueAt = 0
    await this.save()
  }

  onWrapUpNotice(now: number): void {
    this.core.wrapUp.noticeAt = now
    this.log.info('near-limit wrap-up notice seen')
  }

  // The timer

  async tick(): Promise<void> {
    if (this.isTicking) return
    this.isTicking = true
    try {
      await this.step()
      await this.save()
    } catch (error) {
      this.log.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.isTicking = false
    }
  }

  private async step(): Promise<void> {
    if (!this.config.enabled || this.core.isPaused) return
    const now = await this.io.now()
    const a = this.core.activity

    if (await this.stepUsage(now)) return
    if (await this.stepFallback(now)) return
    if (a.isBusy) return
    if (await this.stepRetry(now)) return
    if (await this.stepWrapUp(now)) return
    await this.stepCompact(now)
  }

  private async stepUsage(now: number): Promise<boolean> {
    const u = this.core.usage
    if (u === null) return false
    if (u.isGivenUp || now < u.until) return true
    if (this.core.activity.isBusy) return true
    if (u.submittedAt !== 0 && now - u.submittedAt < USAGE_RECHECK_MS * 4) return true

    const native = this.config.native
    if (native.usageLimit === 'defer' && u.attempts === 0) {
      const isNativeOff = (u.nativeNotice === 'stale' || u.nativeNotice === 'disabled') && u.nativeNoticeAt >= u.enteredAt
      if (!isNativeOff) {
        if (now < u.until + native.graceSeconds * 1000) {
          if (!u.hasLoggedGrace) {
            u.hasLoggedGrace = true
            this.log.info(`reset passed, giving Claude Code's auto-continue ${native.graceSeconds}s (native-grace)`)
          }
          return true
        }
        if (!u.hasLoggedMissed) {
          u.hasLoggedMissed = true
          this.log.warn('Claude Code did not continue on its own (native-missed)')
        }
      }
    }

    if (u.attempts >= this.config.maxRetries) {
      u.isGivenUp = true
      this.log.notice(`usage limit: gave up after ${u.attempts} continues`)
      return true
    }

    if (this.config.networkCheck.enabled && !(await this.isReachable())) {
      if (u.networkDownSince === 0) {
        u.networkDownSince = now
        this.log.warn('API unreachable, holding the continue (network-down)')
      }
      if (now - u.networkDownSince < this.config.networkCheck.maxWaitMinutes * 60_000) {
        u.until = now + NETWORK_RECHECK_MS
        return true
      }
      this.log.warn('API still unreachable, continuing anyway')
    }
    u.networkDownSince = 0

    u.attempts += 1
    u.until = now + USAGE_RECHECK_MS
    u.submittedAt = now
    this.log.notice(`usage limit reset: sending continue ${u.attempts}/${this.config.maxRetries}`)
    await this.submit(this.config.retryMessage)
    return true
  }

  private async stepFallback(now: number): Promise<boolean> {
    const f = this.core.fallback
    if (f === null) return false
    if (now >= f.resetAt) {
      this.log.notice(`${f.from} limit reset: its requests go to ${f.from} again`)
      this.core.fallback = null
      return false
    }
    if (f.phase !== 'switch' || this.core.activity.isBusy) return false
    f.phase = 'continue'
    await this.submit(this.config.retryMessage)
    return true
  }

  private async stepRetry(now: number): Promise<boolean> {
    const r = this.core.retry
    if (r === null || r.isGivenUp || r.isAwaitingResult) return r !== null && !r.isGivenUp
    if (now < r.until) return true
    const message = r.family === 'overload' ? this.config.overload.retryMessage
      : r.family === 'safeguard' ? this.config.safeguard.retryMessage
        : this.config.streamInterrupted.retryMessage
    r.attempts += 1
    r.lastSentAt = now
    r.isAwaitingResult = true
    this.log.notice(`${r.family}: sending retry ${r.attempts}`)
    await this.submit(message)
    return true
  }

  private async stepWrapUp(now: number): Promise<boolean> {
    const w = this.core.wrapUp
    if (w.dueAt === 0 || now < w.dueAt) return false
    w.dueAt = 0
    w.nudges += 1
    this.log.notice(`near-limit wrap-up: sending continue ${w.nudges}/${this.config.nearLimitWrapUp.maxRetries}`)
    await this.submit(this.config.nearLimitWrapUp.retryMessage)
    return true
  }

  private async stepCompact(now: number): Promise<void> {
    const c = this.core.compact
    const a = this.core.activity
    const context = await this.io.context()
    const decision = decideCompact(this.config.compact, {
      now,
      idleSince: a.idleSince,
      isBusy: a.isBusy,
      handledIdleSince: c.handledIdleSince,
      background: a.background ?? await this.io.busyAgents(),
      crons: a.crons,
      permissionAt: a.permissionAt,
      lastSentAt: c.lastSentAt,
      lastAnswer: a.lastAnswer,
      lastMatchedAnswer: c.lastMatchedAnswer,
      request: c.request,
      context: { percent: context.percent, tokens: context.tokens },
      lastUserAt: a.lastUserAt,
      cacheTtlMs: this.cacheTtlMs(context.isSubscription),
    })

    if (decision.action === 'none') {
      c.scheduledFor = 0
      return
    }
    if (decision.action === 'cold') {
      c.handledIdleSince = a.idleSince
      c.scheduledFor = 0
      this.log.info('compaction skipped: the prompt cache has already expired (compact-skipped-cold)')
      return
    }
    if (decision.action === 'wait') {
      c.scheduledFor = decision.fireAt
      if (c.reportedIdleSince !== a.idleSince) {
        c.reportedIdleSince = a.idleSince
        this.log.info(`compaction (${decision.trigger}) scheduled for ${clockOf(decision.fireAt)}`)
      }
      return
    }

    c.handledIdleSince = a.idleSince
    c.lastSentAt = now
    c.scheduledFor = 0
    if (decision.trigger === 'last-message') c.lastMatchedAnswer = a.lastAnswer
    if (decision.trigger === 'request') c.request = null
    await this.compactNow(decision.focus, decision.trigger)
  }

  async compactNow(focus: string, why: string): Promise<void> {
    this.log.notice(`compacting (${why})${focus ? `: ${focus}` : ''}`)
    try {
      const skip = await this.io.compact(focus)
      if (skip !== null) this.log.info(`compaction skipped by a hook: ${skip}`)
    } catch (error) {
      this.log.warn(`compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  cacheTtlMs(isSubscription: boolean): number {
    const minutes = this.config.compact.cacheTtlMinutes
    if (minutes !== null) return minutes * 60_000
    if (this.core.cacheTtlMs !== null) return this.core.cacheTtlMs
    return (isSubscription ? 60 : 5) * 60_000
  }

  private async submit(text: string): Promise<void> {
    try {
      await this.io.submit(text)
    } catch (error) {
      this.log.warn(`could not send "${text}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async isReachable(): Promise<boolean> {
    return this.io.isReachable(this.config.networkCheck.url, NETWORK_TIMEOUT_MS)
  }

  // Person's actions, from the command and the band

  async continueNow(): Promise<string> {
    const now = await this.io.now()
    if (this.core.usage !== null) {
      this.core.usage.until = now
      this.core.usage.isGivenUp = false
      this.core.usage.attempts = Math.max(this.core.usage.attempts, 1)
      this.core.usage.submittedAt = 0
    } else if (this.core.retry !== null) {
      this.core.retry.until = now
      this.core.retry.isGivenUp = false
      this.core.retry.isAwaitingResult = false
    } else {
      return 'Nothing is waiting.'
    }
    await this.tick()
    return 'Sent the continue.'
  }

  async cancel(): Promise<string> {
    const had = this.core.usage !== null || this.core.retry !== null || this.core.compact.scheduledFor !== 0
    this.core.usage = null
    this.core.retry = null
    this.core.wrapUp.dueAt = 0
    this.core.compact.handledIdleSince = this.core.activity.idleSince
    this.core.compact.scheduledFor = 0
    await this.save()
    return had ? 'Dropped what was pending for this session.' : 'Nothing was pending.'
  }

  async requestCompact(focus: string): Promise<string> {
    const now = await this.io.now()
    if (!this.config.compact.enabled || this.config.compact.trigger === 'policy') {
      return 'Compaction requests are off. Set compact.enabled and compact.trigger to "request" or "both".'
    }
    this.core.compact.request = { at: now, focus }
    if (this.core.compact.handledIdleSince === this.core.activity.idleSince) this.core.compact.handledIdleSince = 0
    await this.save()
    const ttl = this.cacheTtlMs((await this.io.context()).isSubscription)
    const margin = this.config.compact.settle.mode === 'before-expiry'
      ? ttl - this.config.compact.settle.marginSeconds * 1000
      : this.config.compact.settle.minutes * 60_000
    return `Compaction requested. It runs once the session has been idle for ${durationOf(margin)}${focus ? `, keeping: ${focus}` : ''}.`
  }
}

/**
 * What an alias in modelFallback.map stands for: a request rewritten by a
 * hook goes out as named, so an alias has to be a full id by then.
 */
const MODEL_IDS: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
}

export const modelIdOf = (name: string) => MODEL_IDS[name.toLowerCase()] ?? name

export const isPersonPrompt = (kind: string) => PERSON_ORIGINS.has(kind)

export function backgroundOf(tasks: unknown): number | null {
  if (!Array.isArray(tasks)) return null
  return tasks.filter((t: { type?: unknown }) => !LONG_LIVED_TASKS.has(String(t?.type))).length
}
