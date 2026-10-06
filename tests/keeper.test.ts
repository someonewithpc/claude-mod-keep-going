import { describe, expect, test } from 'claude-code/testing'

import { classify, nativeNoticeOf } from '../hooks/classify'
import { fakeOf, turn } from './fake-io'

const MIN = 60_000
const HOUR = 60 * MIN
const SESSION_LIMIT = "You've hit your session limit · resets 3:50pm (Europe/Lisbon)"

describe('classify', () => {
  test('a session limit waits for the reset', () => {
    expect(classify('rate_limit', SESSION_LIMIT)).toEqual({ kind: 'usage', text: SESSION_LIMIT, model: null })
  })

  test('a one-model limit names the model, with or without a reset', () => {
    expect(classify('rate_limit', "You've hit your Opus limit · resets Oct 9, 10am")).toMatchObject({ model: 'Opus' })
    expect(classify('rate_limit', "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model."))
      .toMatchObject({ kind: 'usage', model: 'Fable' })
  })

  test('the API-level 429 is an overload, not a usage limit', () => {
    expect(classify('rate_limit', 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'))
      .toMatchObject({ kind: 'overload' })
  })

  test('a cut-off stream is told from a 5xx by its words', () => {
    const cut = 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.'
    expect(classify('server_error', cut)).toMatchObject({ kind: 'interrupted' })
    expect(classify('server_error', 'API Error: 500 {"type":"error"}')).toMatchObject({ kind: 'overload' })
    expect(classify(null, 'API Error: Connection lost before a response was produced. Try again.')).toMatchObject({ kind: 'interrupted' })
  })

  test('a custom pattern marks a new limit message as a usage limit', () => {
    expect(classify(null, 'Quota spent until 3pm', ['quota spent'])).toMatchObject({ kind: 'usage' })
  })

  test('a safeguard flag is retried, a login error is not', () => {
    expect(classify('invalid_request', "API Error: Opus's safeguards flagged this message (https://www.anthropic.com/legal/aup)."))
      .toMatchObject({ kind: 'safeguard' })
    expect(classify('authentication_failed', 'Not logged in · Please run /login')).toBe(null)
    expect(classify(null, 'I fixed the 529 handling in server.ts')).toBe(null)
  })
})

describe('Claude Code auto-continue notices', () => {
  test('are told apart by their words', () => {
    expect(nativeNoticeOf('Usage limit reached · continuing automatically at 9:42am · esc to cancel')).toBe('armed')
    expect(nativeNoticeOf('Usage limit reset · continuing automatically')).toBe('fired')
    expect(nativeNoticeOf('Usage limit has reset · press enter to continue')).toBe('stale')
    expect(nativeNoticeOf('Automatic continue was turned off · this task will not resume on its own')).toBe('disabled')
    expect(nativeNoticeOf('Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own')).toBe('disabled')
    expect(nativeNoticeOf('Compacted the conversation')).toBe(null)
  })

  test('one shown before the failure is classified still counts', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    f.keeper.onNotice(f.clock.now, 'Usage limit reached · continuing automatically at 2pm · esc to cancel')
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    expect(f.keeper.core.usage?.nativeNotice).toBe('armed')
  })

  test('one that says it will not continue means no grace period', async () => {
    const f = fakeOf({ networkCheck: { enabled: false } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your weekly limit · resets 2pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    f.keeper.onNotice(f.clock.now, 'Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own')
    await f.advance(2 * HOUR + MIN)
    expect(f.submitted).toHaveLength(1)
  })
})

describe('usage limit', () => {
  test('waits for the reset the API reports, then sends one continue', async () => {
    const f = fakeOf({ native: { usageLimit: 'ignore' }, networkCheck: { enabled: false } })
    const reset = f.clock.now + 2 * HOUR
    f.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(reset).toISOString() }]

    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', SESSION_LIMIT)
    await f.keeper.onTurnComplete('error', SESSION_LIMIT)

    expect(f.keeper.core.usage?.until).toBe(reset + MIN)
    await f.advance(2 * HOUR)
    expect(f.submitted).toEqual([])
    await f.advance(MIN)
    expect(f.submitted).toEqual(['Continue where you left off. The previous attempt was rate limited.'])

    await turn(f, 'answer')
    expect(f.keeper.core.usage).toBe(null)
  })

  test('reads a reset in a named time zone, summer time included', async () => {
    const f = fakeOf({ native: { usageLimit: 'ignore' } }, Date.UTC(2026, 6, 1, 12, 0))
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', SESSION_LIMIT)
    expect(f.keeper.core.usage?.until).toBe(Date.UTC(2026, 6, 1, 14, 51))
  })

  test('reads the reset time off the banner when the API gave none', async () => {
    const f = fakeOf({ native: { usageLimit: 'ignore' } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    expect(f.keeper.core.usage?.until).toBe(Date.UTC(2026, 9, 6, 14, 1))
    expect(f.keeper.core.usage?.isFallback).toBe(false)
  })

  test('gives Claude Code its own auto-continue first', async () => {
    const f = fakeOf({ networkCheck: { enabled: false } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    await f.advance(2 * HOUR + MIN)
    expect(f.submitted).toEqual([])
    expect(f.infos.some((l) => l.includes('native-grace'))).toBe(true)

    await f.advance(3 * MIN)
    expect(f.submitted).toHaveLength(1)
    expect(f.infos.some((l) => l.includes('native-missed'))).toBe(true)
  })

  test('sends at once when Claude Code says its auto-continue is off', async () => {
    const f = fakeOf({ networkCheck: { enabled: false } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    f.keeper.onNotification(f.clock.now, 'quota_auto_resume_disabled')
    await f.advance(2 * HOUR + MIN)
    expect(f.submitted).toHaveLength(1)
  })

  test('holds the continue while the API is unreachable', async () => {
    const f = fakeOf({ native: { usageLimit: 'ignore' } })
    f.isReachable = false
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    await f.advance(2 * HOUR + MIN)
    expect(f.submitted).toEqual([])
    f.isReachable = true
    await f.advance(20_000)
    expect(f.submitted).toHaveLength(1)
  })

  test('a person typing during the wait takes over', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', SESSION_LIMIT)
    await f.keeper.onTurnComplete('error', '')
    await f.keeper.onPersonPrompt()
    expect(f.keeper.core.usage).toBe(null)
  })

  test('gives up after maxRetries continues that hit the limit again', async () => {
    const f = fakeOf({ maxRetries: 2, native: { usageLimit: 'ignore' }, networkCheck: { enabled: false } })
    for (let i = 0; i < 3; i++) {
      await f.keeper.onTurnStart()
      await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets in 1 minute")
      await f.keeper.onTurnComplete('error', '')
      await f.advance(3 * MIN)
    }
    expect(f.submitted).toHaveLength(2)
    expect(f.keeper.core.usage?.isGivenUp).toBe(true)
  })

  test('a fallback wait moves to the reset the API reports later', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You're out of extra usage")
    expect(f.keeper.core.usage?.isFallback).toBe(true)
    const reset = f.clock.now + 30 * MIN
    f.rateLimits = [{ kind: 'seven_day', percentUsed: 100, resetsAt: new Date(reset).toISOString() }]
    await f.keeper.onMeasure()
    expect(f.keeper.core.usage?.until).toBe(reset + MIN)
  })
})

describe('retries', () => {
  test('backs off on overload and stops after the cumulative cap', async () => {
    const f = fakeOf({ overload: { backoffSeconds: [60], steadyStateSeconds: 600, maxTotalWaitMinutes: 12, jitterMode: 'proportional', jitterPct: 0 } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('overloaded', 'API Error: 529 overloaded_error')
    await f.keeper.onTurnComplete('error', '')
    await f.advance(59_000)
    expect(f.submitted).toEqual([])
    await f.advance(1_000)
    expect(f.submitted).toEqual(['Continue where you left off.'])

    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('overloaded', 'API Error: 529 overloaded_error')
    await f.keeper.onTurnComplete('error', '')
    expect(f.keeper.core.retry?.until).toBe(f.clock.now + 600_000)

    await f.advance(600_000)
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('overloaded', 'API Error: 529 overloaded_error')
    await f.keeper.onTurnComplete('error', '')
    expect(f.keeper.core.retry?.isGivenUp).toBe(true)
  })

  test('a usage limit never enters the overload backoff', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', SESSION_LIMIT)
    expect(f.keeper.core.retry).toBe(null)
    expect(f.keeper.core.usage).not.toBe(null)
  })

  test('re-sends after a safeguard flag, a few times at most', async () => {
    const f = fakeOf({ safeguard: { maxRetries: 2, retryDelaySeconds: 8 } })
    for (let i = 0; i < 3; i++) {
      await turn(f, 'refusal', "API Error: Opus's safeguards flagged this message")
      await f.advance(8_000)
    }
    expect(f.submitted).toEqual(['continue', 'continue'])
    expect(f.keeper.core.retry?.isGivenUp).toBe(true)
  })

  test('resumes a cut-off response found only in the turn it ended', async () => {
    const f = fakeOf()
    await turn(f, 'error', 'API Error: Connection lost mid-response. The response above may be incomplete.')
    await f.advance(2_000)
    expect(f.keeper.core.retry?.family).toBe('interrupted')
    await f.advance(5_000)
    expect(f.submitted).toEqual(['continue'])
    await turn(f, 'answer')
    expect(f.keeper.core.retry).toBe(null)
  })

  test('reads the error after a partial answer', async () => {
    const f = fakeOf()
    f.lastText = 'API Error: Connection lost mid-response. The response above may be incomplete.'
    await turn(f, 'error', 'Half of an answer')
    await f.advance(2_000)
    expect(f.keeper.core.retry?.family).toBe('interrupted')
  })

  test('one failure is handled once when both signals arrive', async () => {
    const f = fakeOf({ overload: { backoffSeconds: [30], jitterMode: 'proportional', jitterPct: 0 } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('overloaded', 'API Error: 529')
    await f.keeper.onTurnComplete('error', 'API Error: 529')
    await f.advance(2_000)
    expect(f.keeper.core.retry?.until).toBe(Date.UTC(2026, 9, 6, 12, 0) + 30_000)
  })
})

describe('wrap-up nudge', () => {
  test('sends one continue after the turn Claude wound down', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    f.keeper.onWrapUpNotice(f.clock.now)
    await f.keeper.onTurnComplete('answer', 'Remaining work: ...')
    await f.advance(2_000)
    expect(f.submitted).toEqual(['continue'])
  })

  test('leaves it alone once the person answered', async () => {
    const f = fakeOf()
    await f.keeper.onTurnStart()
    f.keeper.onWrapUpNotice(f.clock.now)
    await f.keeper.onTurnComplete('answer', '')
    await f.keeper.onPersonPrompt()
    await f.advance(2_000)
    expect(f.submitted).toEqual([])
  })
})

describe('compaction', () => {
  const POLICY = { compact: { enabled: true, trigger: 'both', minContextPercent: 0, minContextTokens: 100000, waitForAgents: false } }

  test('compacts five minutes before a one-hour cache expires', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(f, 'answer')
    f.keeper.onStop(1, 0)
    await f.advance(54 * MIN)
    expect(f.compacted).toEqual([])
    expect(f.keeper.core.compact.scheduledFor).toBe(Date.UTC(2026, 9, 6, 12, 55))
    await f.advance(MIN)
    expect(f.compacted).toEqual([''])
  })

  test('a small context is left alone', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 10, tokens: 20_000, isSubscription: true }
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([])
  })

  test('waits for background agents when asked to', async () => {
    const f = fakeOf({ compact: { ...POLICY.compact, waitForAgents: true } })
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    f.agents = 1
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([])
    f.agents = 0
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([''])
  })

  test('a request from Claude carries its focus', async () => {
    const f = fakeOf({ compact: { enabled: true, trigger: 'request' } })
    await turn(f, 'answer')
    await f.keeper.requestCompact('the open bugs')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual(['the open bugs'])
    expect(f.keeper.core.compact.request).toBe(null)
  })

  test('the last message asking for /compact triggers it once', async () => {
    const f = fakeOf({ compact: { enabled: true, trigger: 'request', matchLastMessage: true } })
    await turn(f, 'answer', 'All done. Run /compact when you are back.')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([''])
    await f.advance(60 * MIN)
    expect(f.compacted).toHaveLength(1)
  })

  test('a cold cache is skipped, not compacted', async () => {
    const f = fakeOf({ compact: { ...POLICY.compact, cacheTtlMinutes: 5 } })
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(f, 'answer')
    await f.advance(10 * MIN)
    expect(f.compacted).toEqual([])
  })
})

describe('compaction waits', () => {
  const POLICY = { compact: { enabled: true, trigger: 'policy', minContextPercent: 0, waitForAgents: true } }

  test('for a scheduled wakeup, and goes ahead once it has fired', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    f.keeper.onToolCall(f.clock.now, 'ScheduleWakeup', { delaySeconds: 3600 }, null)
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([])
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([''])
  })

  test('for a recurring cron until it is deleted', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    f.keeper.onToolCall(f.clock.now, 'CronCreate', { cron: '*/5 * * * *', prompt: 'x' }, { id: 'a', recurring: true })
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([])
    f.keeper.onToolCall(f.clock.now, 'CronDelete', { id: 'a' }, null)
    await turn(f, 'answer')
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([''])
  })

  test('uses the expiry the statusline saved', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(f, 'answer')
    f.cache = { expiresAt: f.clock.now + 20 * MIN, isWarm: true }
    await f.advance(14 * MIN)
    expect(f.compacted).toEqual([])
    await f.advance(MIN)
    expect(f.compacted).toEqual([''])
  })

  test('skips a cache the statusline says is cold, or one a model switch made cold', async () => {
    const f = fakeOf(POLICY)
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(f, 'answer')
    f.cache = { expiresAt: null, isWarm: false }
    await f.advance(56 * MIN)
    expect(f.compacted).toEqual([])

    const g = fakeOf(POLICY)
    g.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(g, 'answer')
    g.model = 'claude-sonnet-5-5'
    await g.advance(56 * MIN)
    expect(g.compacted).toEqual([])
  })

  test('away means no typing in the prompt box', async () => {
    const f = fakeOf({ compact: { ...POLICY.compact, awayMinutes: 30 } })
    f.context = { percent: 30, tokens: 150_000, isSubscription: true }
    await turn(f, 'answer')
    await f.advance(50 * MIN)
    f.keeper.onEdit(f.clock.now)
    await f.advance(6 * MIN)
    expect(f.compacted).toEqual([])
  })
})

describe('model fallback', () => {
  test('sends to the model id it saw answer for that alias', async () => {
    const f = fakeOf({ modelFallback: { enabled: true, map: { Opus: 'sonnet' } } })
    f.keeper.learnModel('claude-sonnet-6-0')
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your Opus limit · resets 3pm (UTC)")
    expect(f.keeper.stepModel('claude-opus-5-5', f.clock.now)).toBe('claude-sonnet-6-0')
  })

  test('a fallback model that does not answer turns into a wait', async () => {
    const f = fakeOf({ modelFallback: { enabled: true, map: { Opus: 'sonnet' } } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your Opus limit · resets 3pm (UTC)")
    f.keeper.onFallbackFailed()
    await f.advance(0)
    expect(f.keeper.core.fallback).toBe(null)
    expect(f.keeper.core.usage?.until).toBe(Date.UTC(2026, 9, 6, 15, 1))
  })

  test("sends one model's requests elsewhere until its reset, without /model", async () => {
    const f = fakeOf({ modelFallback: { enabled: true, map: { Opus: 'sonnet' } } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your Opus limit · resets 3pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    expect(f.keeper.stepModel('claude-opus-5-5', f.clock.now)).toBe('claude-sonnet-5-5')
    expect(f.keeper.stepModel('claude-haiku-4-5-20251001', f.clock.now)).toBe(null)
    await f.advance(5_000)
    expect(f.submitted).toHaveLength(1)

    await f.advance(3 * HOUR + MIN)
    expect(f.keeper.core.fallback).toBe(null)
    expect(f.keeper.stepModel('claude-opus-5-5', f.clock.now)).toBe(null)
  })

  test('an unmapped model waits like any usage limit', async () => {
    const f = fakeOf({ modelFallback: { enabled: true, map: { Opus: 'sonnet' } } })
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've reached your Fable limit. Run /usage-credits to continue")
    expect(f.keeper.core.fallback).toBe(null)
    expect(f.keeper.core.usage?.isFallback).toBe(true)
  })
})

describe('badge', () => {
  test('counts down a usage wait, then goes back to green', async () => {
    const f = fakeOf({ native: { usageLimit: 'ignore' }, networkCheck: { enabled: false } })
    await f.keeper.save()
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', "You've hit your session limit · resets 2pm (UTC)")
    await f.keeper.onTurnComplete('error', '')
    await f.advance(80 * MIN)
    await turn(f, 'answer')
    expect(f.badges).toEqual(['🟢KG', '⏳KG 2h01m', '⏳KG 41m', '🟢KG'])
  })
})

describe('restart', () => {
  test('a usage wait comes back after a restart from the store', async () => {
    const f = fakeOf()
    f.keeper.sessionId = 'abc'
    await f.keeper.onTurnStart()
    await f.keeper.onStopFailure('rate_limit', SESSION_LIMIT)
    const until = f.keeper.core.usage?.until

    const g = fakeOf()
    g.io.storeGet = f.io.storeGet
    await g.keeper.restore('abc')
    expect(g.keeper.core.usage?.until).toBe(until)
  })
})
