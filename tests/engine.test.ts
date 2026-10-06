import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 6, 12, 0)
const RESET = NOW + 2 * 3600_000

type World = {
  submitted: string[]
  compacted: (string | undefined)[]
  statuses: (string | undefined)[]
  transcript: string[]
  badges: string[]
  clock: ReturnType<typeof mock.clock>
}

/** The engine beneath the mod: a session on a mocked clock, every effect kept. */
function worldOf(on: On, files: Record<string, string> = {}, isLimited = true): World {
  const world: World = {
    submitted: [],
    compacted: [],
    statuses: [],
    transcript: [],
    badges: [],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.store(on)
  mock.env(on, { HOME: '/home/t', XDG_RUNTIME_DIR: '/run/user/1000' })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: '0123456789abcdef' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1_000_000, tokens: 150_000, percent: 15 },
      rateLimits: isLimited ? [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(RESET).toISOString() }] : [],
    },
  }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (e.path.includes('/badge/')) world.badges.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '' } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__keep-going__${e.name}` } }))
  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.compact', ($, e) => {
    world.compacted.push(e.instructions)
    return { messages: e.messages }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') world.transcript.push(e.text)
    return { value: undefined }
  })
  return world
}

const SESSION = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const ENDED = { answer: '', durationMs: 1000, isAborted: false, turnId: 't1' } as const

describe('through the engine', () => {
  test('a usage limit is continued once the window resets', async ($, on) => {
    const world = worldOf(on, {
      '/home/t/.config/claude-keep-going/config.json': JSON.stringify({ native: { usageLimit: 'ignore' } }),
    })
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.classic.StopFailure({
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 2pm (UTC)",
    })
    await $.turn.complete({ ...ENDED, reason: 'error' })
    await world.clock.settle()
    expect(world.transcript.some((l) => l.includes('continuing at'))).toBe(true)

    await world.clock.advance(2 * 3600_000 + 30_000)
    expect(world.submitted).toEqual([])
    await world.clock.advance(60_000)
    expect(world.submitted).toEqual(['Continue where you left off. The previous attempt was rate limited.'])
  })

  test('the command reports and cancels what is pending', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.classic.StopFailure({ error: 'overloaded', last_assistant_message: 'API Error: 529 overloaded_error' })
    await $.turn.complete({ ...ENDED, reason: 'error' })
    await world.clock.settle()

    const status = await $.command.run({ ...TYPED, command: 'keep-going', args: '' })
    expect(status.text).toContain('API error: retry 1 in')
    const cancelled = await $.command.run({ ...TYPED, command: 'keep-going', args: 'cancel' })
    expect(cancelled.text).toBe('Dropped what was pending for this session.')
    await world.clock.advance(10 * 60_000)
    expect(world.submitted).toEqual([])
  })

  test('the model can ask for a compaction', async ($, on) => {
    const world = worldOf(on, {
      '/etc/xdg/claude-keep-going/config.json': JSON.stringify({ compact: { enabled: true, trigger: 'request' } }),
    })
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ ...ENDED, reason: 'answer' })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
    const called = await $.tool.call({ tool: 'mcp__keep-going__request_compact', focus: 'the plan' })
    expect(String(called.result)).toContain('Compaction requested')

    await world.clock.advance(56 * 60_000)
    expect(world.compacted).toEqual(['the plan'])
  })

  test('the band offers to continue now on the terminal and the desktop', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.classic.StopFailure({ error: 'overloaded', last_assistant_message: 'API Error: 529' })
    await $.turn.complete({ ...ENDED, reason: 'error' })
    await world.clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'keep-going', surface, component: 'AbovePrompt', props: {} as never })
      expect(await ui.find({ key: 'continue' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('the usage-limit menu', () => {
  test('is answered when Claude Code opens it on a limit', async ($, on) => {
    const world = worldOf(on)
    let shown = 0
    on('command.run', { command: 'rate-limit-options' }, () => {
      shown += 1
      return { text: 'menu' }
    })
    await $.session.start(SESSION)
    await world.clock.advance(60_000)
    await $.command.run({ ...TYPED, command: 'rate-limit-options', args: '' })
    expect(shown).toBe(0)
  })

  test('is shown when no limit is hit', async ($, on) => {
    const world = worldOf(on, {}, false)
    let shown = 0
    on('command.run', { command: 'rate-limit-options' }, () => {
      shown += 1
      return { text: 'menu' }
    })
    await $.session.start(SESSION)
    await world.clock.advance(60_000)
    await $.command.run({ ...TYPED, command: 'rate-limit-options', args: '' })
    expect(shown).toBe(1)
  })
})

describe('a print run', () => {
  test('sends a request that failed before any answer again', async ($, on) => {
    const world = worldOf(on, {}, false)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    let sent = 0
    on('turn.step', async function* ($, e) {
      sent += 1
      if (sent === 1) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      return {
        turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-4-5-20251001' },
      }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001', messageCount: 1 })
    let step = await stream.next()
    while (step.done !== true) step = await stream.next()
    const result = step.value
    expect(sent).toBe(2)
    expect(result.stopReason).toBe('end_turn')
    void world
  })
})
