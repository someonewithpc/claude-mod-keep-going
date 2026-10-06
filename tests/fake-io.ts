import type { SessionRateLimit } from 'claude-code'

import { validate } from '../hooks/config'
import { Keeper, type Io } from '../hooks/keeper'
import type { KeepGoingCore } from '../types'

export type Fake = {
  keeper: Keeper
  io: Io
  clock: { now: number }
  submitted: string[]
  compacted: string[]
  notices: string[]
  infos: string[]
  status: (string | undefined)[]
  badges: string[]
  rateLimits: SessionRateLimit[]
  context: { percent: number | null; tokens: number | null; isSubscription: boolean }
  isReachable: boolean
  model: string
  agents: number
  timers: { at: number; fn: () => void }[]
  advance: (ms: number) => Promise<void>
}

/** A keeper on a fake engine: a clock the test moves, and every effect recorded. */
export function fakeOf(raw: unknown = {}, now = Date.UTC(2026, 9, 6, 12, 0)): Fake {
  const notices: string[] = []
  const infos: string[] = []
  const keeper = new Keeper({
    info: (line) => infos.push(line),
    warn: (line) => infos.push(line),
    notice: (line) => notices.push(line),
  })
  keeper.config = validate(raw)
  keeper.random = () => 0.5
  const store = new Map<string, unknown>()
  let held: KeepGoingCore | null = null

  const fake: Fake = {
    keeper,
    clock: { now },
    submitted: [],
    compacted: [],
    notices,
    infos,
    status: [],
    badges: [],
    rateLimits: [],
    context: { percent: null, tokens: null, isSubscription: true },
    isReachable: true,
    model: 'claude-opus-5-5',
    agents: 0,
    timers: [],
    advance: async (ms) => {
      const to = fake.clock.now + ms
      for (;;) {
        const due = fake.timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        fake.timers.splice(fake.timers.indexOf(due), 1)
        fake.clock.now = due.at
        due.fn()
        for (let i = 0; i < 10; i++) await Promise.resolve()
      }
      fake.clock.now = to
      await keeper.tick()
    },
    io: undefined as unknown as Io,
  }

  fake.io = {
    now: async () => fake.clock.now,
    saveState: async (core) => {
      held = JSON.parse(JSON.stringify(core))
    },
    loadCore: async () => held,
    status: (text) => fake.status.push(text),
    writeBadge: async (badge) => {
      fake.badges.push(badge)
    },
    storeGet: async (key) => store.get(key),
    storeSet: async (key, value) => {
      store.set(key, value)
    },
    storeKeys: async () => [...store.keys()],
    storeDelete: async (key) => {
      store.delete(key)
    },
    rateLimits: async () => fake.rateLimits,
    context: async () => fake.context,
    model: async () => fake.model,
    lastAssistantText: async () => '',
    busyAgents: async () => fake.agents,
    submit: async (text) => {
      fake.submitted.push(text)
    },
    compact: async (focus) => {
      fake.compacted.push(focus)
      return null
    },
    isReachable: async () => fake.isReachable,
    after: (ms, fn) => {
      fake.timers.push({ at: fake.clock.now + ms, fn })
    },
  }
  keeper.io = fake.io
  return fake
}

/** One main-loop turn: it starts, then ends for `reason` with `answer`. */
export async function turn(f: Fake, reason: string, answer = 'done'): Promise<void> {
  await f.keeper.onTurnStart()
  await f.keeper.onTurnComplete(reason, answer)
}
