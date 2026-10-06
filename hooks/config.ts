export type CompactTrigger = 'request' | 'policy' | 'both'

export type Config = {
  enabled: boolean
  maxRetries: number
  marginSeconds: number
  fallbackWaitHours: number
  tickSeconds: number
  retryMessage: string
  /** Extra regexes, case-insensitive, that mark an error message as a usage limit. */
  customPatterns: string[]
  overload: {
    enabled: boolean
    backoffSeconds: number[]
    steadyStateSeconds: number
    jitterPct: number
    jitterMode: 'full' | 'proportional'
    maxTotalWaitMinutes: number
    retryMessage: string
  }
  safeguard: BoundedRetry
  streamInterrupted: BoundedRetry
  nearLimitWrapUp: { enabled: boolean; maxRetries: number; retryMessage: string }
  compact: {
    enabled: boolean
    trigger: CompactTrigger
    window: { start: string; end: string } | null
    awayMinutes: number | null
    minContextPercent: number
    minContextTokens: number | null
    settle: { mode: 'before-expiry' | 'fixed'; marginSeconds: number; minutes: number }
    cacheTtlMinutes: number | null
    focus: string
    matchLastMessage: boolean
    minIntervalMinutes: number
    waitForAgents: boolean
  }
  native: { usageLimit: 'defer' | 'ignore'; graceSeconds: number; rateLimitMenu: 'skip' | 'show' }
  print: { enabled: boolean; maxWaitHours: number }
  debug: { dumpEvents: boolean }
  networkCheck: { enabled: boolean; url: string; maxWaitMinutes: number }
  modelFallback: { enabled: boolean; map: Record<string, string>; switchBack: boolean }
  ui: { statusLine: 'active' | 'always' | 'off'; band: boolean }
}

export type BoundedRetry = {
  enabled: boolean
  maxRetries: number
  retryDelaySeconds: number
  retryMessage: string
}

export const DEFAULTS: Config = {
  enabled: true,
  maxRetries: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  tickSeconds: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: {
    enabled: true,
    backoffSeconds: [30, 60, 120, 240, 300],
    steadyStateSeconds: 300,
    jitterPct: 15,
    jitterMode: 'full',
    maxTotalWaitMinutes: 120,
    retryMessage: 'Continue where you left off.',
  },
  safeguard: { enabled: true, maxRetries: 3, retryDelaySeconds: 8, retryMessage: 'continue' },
  streamInterrupted: { enabled: true, maxRetries: 2, retryDelaySeconds: 5, retryMessage: 'continue' },
  nearLimitWrapUp: { enabled: true, maxRetries: 3, retryMessage: 'continue' },
  compact: {
    enabled: false,
    trigger: 'request',
    window: null,
    awayMinutes: null,
    minContextPercent: 40,
    minContextTokens: null,
    settle: { mode: 'before-expiry', marginSeconds: 300, minutes: 4 },
    cacheTtlMinutes: null,
    focus: '',
    matchLastMessage: false,
    minIntervalMinutes: 30,
    waitForAgents: true,
  },
  native: { usageLimit: 'defer', graceSeconds: 180, rateLimitMenu: 'skip' },
  print: { enabled: true, maxWaitHours: 6 },
  debug: { dumpEvents: false },
  networkCheck: { enabled: true, url: 'https://api.anthropic.com/', maxWaitMinutes: 10 },
  modelFallback: { enabled: false, map: { Opus: 'sonnet' }, switchBack: true },
  ui: { statusLine: 'active', band: true },
}

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown, min: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

const text = (v: unknown, fallback: string) => (typeof v === 'string' && v !== '' ? v : fallback)

function oneOf<T extends string>(v: unknown, values: readonly T[], fallback: T): T {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback
}

const nullableNum = (v: unknown, min: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? v : null

const block = (v: unknown): Raw => (isObject(v) ? v : {})

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/

function boundedRetry(raw: unknown, d: BoundedRetry): BoundedRetry {
  const b = block(raw)
  return {
    enabled: bool(b.enabled, d.enabled),
    maxRetries: num(b.maxRetries, 1, d.maxRetries),
    retryDelaySeconds: num(b.retryDelaySeconds, 1, d.retryDelaySeconds),
    retryMessage: text(b.retryMessage, d.retryMessage),
  }
}

export function validate(raw: unknown): Config {
  const r = block(raw)
  const d = DEFAULTS

  const o = block(r.overload)
  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : []

  const c = block(r.compact)
  const settle = block(c.settle)
  const window = isObject(c.window) && CLOCK.test(String(c.window.start)) && CLOCK.test(String(c.window.end))
    ? { start: String(c.window.start), end: String(c.window.end) }
    : null

  const nw = block(r.native)
  const nc = block(r.networkCheck)
  const mf = block(r.modelFallback)
  const map = isObject(mf.map) ? mf.map : d.modelFallback.map
  const ui = block(r.ui)

  return {
    enabled: bool(r.enabled, d.enabled),
    maxRetries: num(r.maxRetries, 1, d.maxRetries),
    marginSeconds: num(r.marginSeconds, 0, d.marginSeconds),
    fallbackWaitHours: num(r.fallbackWaitHours, 0.1, d.fallbackWaitHours),
    tickSeconds: num(r.tickSeconds ?? r.pollIntervalSeconds, 1, d.tickSeconds),
    retryMessage: text(r.retryMessage, d.retryMessage),
    customPatterns: Array.isArray(r.customPatterns)
      ? r.customPatterns.filter((p): p is string => {
          if (typeof p !== 'string' || p === '') return false
          try {
            new RegExp(p, 'i')
            return true
          } catch {
            return false
          }
        })
      : [],
    overload: {
      enabled: bool(o.enabled, d.overload.enabled),
      backoffSeconds: backoff.length > 0 ? backoff : [...d.overload.backoffSeconds],
      steadyStateSeconds: num(o.steadyStateSeconds, 1, d.overload.steadyStateSeconds),
      jitterPct: Math.min(100, num(o.jitterPct, 0, d.overload.jitterPct)),
      jitterMode: oneOf(o.jitterMode, ['full', 'proportional'], d.overload.jitterMode),
      maxTotalWaitMinutes: num(o.maxTotalWaitMinutes, 0.1, d.overload.maxTotalWaitMinutes),
      retryMessage: text(o.retryMessage, d.overload.retryMessage),
    },
    safeguard: boundedRetry(r.safeguard, d.safeguard),
    streamInterrupted: boundedRetry(r.streamInterrupted, d.streamInterrupted),
    nearLimitWrapUp: {
      enabled: bool(block(r.nearLimitWrapUp).enabled, d.nearLimitWrapUp.enabled),
      maxRetries: num(block(r.nearLimitWrapUp).maxRetries, 1, d.nearLimitWrapUp.maxRetries),
      retryMessage: text(block(r.nearLimitWrapUp).retryMessage, d.nearLimitWrapUp.retryMessage),
    },
    compact: {
      enabled: bool(c.enabled, d.compact.enabled),
      trigger: oneOf(c.trigger, ['request', 'policy', 'both'], d.compact.trigger),
      window,
      awayMinutes: nullableNum(c.awayMinutes, 0),
      minContextPercent: Math.min(100, num(c.minContextPercent, 0, d.compact.minContextPercent)),
      minContextTokens: nullableNum(c.minContextTokens, 0),
      settle: {
        mode: oneOf(settle.mode, ['before-expiry', 'fixed'], d.compact.settle.mode),
        marginSeconds: num(settle.marginSeconds, 0, d.compact.settle.marginSeconds),
        minutes: num(settle.minutes, 0, d.compact.settle.minutes),
      },
      cacheTtlMinutes: nullableNum(c.cacheTtlMinutes, 1),
      focus: typeof c.focus === 'string' ? c.focus : d.compact.focus,
      matchLastMessage: bool(c.matchLastMessage, d.compact.matchLastMessage),
      minIntervalMinutes: num(c.minIntervalMinutes, 0, d.compact.minIntervalMinutes),
      waitForAgents: bool(c.waitForAgents, d.compact.waitForAgents),
    },
    native: {
      usageLimit: oneOf(nw.usageLimit, ['defer', 'ignore'], d.native.usageLimit),
      graceSeconds: num(nw.graceSeconds, 0, d.native.graceSeconds),
      rateLimitMenu: oneOf(nw.rateLimitMenu, ['skip', 'show'], d.native.rateLimitMenu),
    },
    print: {
      enabled: bool(block(r.print).enabled, d.print.enabled),
      maxWaitHours: num(block(r.print).maxWaitHours, 0, d.print.maxWaitHours),
    },
    debug: { dumpEvents: bool(block(r.debug).dumpEvents, d.debug.dumpEvents) },
    networkCheck: {
      enabled: bool(nc.enabled, d.networkCheck.enabled),
      url: typeof nc.url === 'string' && /^https?:\/\//.test(nc.url) ? nc.url : d.networkCheck.url,
      maxWaitMinutes: num(nc.maxWaitMinutes, 0, d.networkCheck.maxWaitMinutes),
    },
    modelFallback: {
      enabled: bool(mf.enabled, d.modelFallback.enabled),
      switchBack: bool(mf.switchBack, d.modelFallback.switchBack),
      map: Object.fromEntries(
        Object.entries(map).filter(
          (entry): entry is [string, string] =>
            entry[0] !== '' && typeof entry[1] === 'string' && /^[\w.:[\]-]+$/.test(entry[1]),
        ),
      ),
    },
    ui: {
      statusLine: oneOf(ui.statusLine, ['active', 'always', 'off'], d.ui.statusLine),
      band: bool(ui.band, d.ui.band),
    },
  }
}

/**
 * Two config files, merged one level deep with the user's on top: the
 * system one (`$XDG_CONFIG_DIRS`, `/etc/xdg` by default) and the user's
 * (`$XDG_CONFIG_HOME`, `~/.config` by default). The paths are the ones the
 * claude-keep-going CLI reads, so an existing config keeps working.
 */
export function mergeFiles(files: readonly unknown[]): Raw {
  const merged: Raw = {}
  for (const file of files) {
    if (!isObject(file)) continue
    for (const [key, value] of Object.entries(file)) {
      merged[key] = isObject(value) && isObject(merged[key])
        ? { ...(merged[key] as Raw), ...value }
        : value
    }
  }
  return merged
}

/**
 * The `/config` rows the manifest declares, laid over the file. `config`
 * leaves the file's value alone.
 */
export function applyOptions(raw: Raw, options: Readonly<Record<string, unknown>>): Raw {
  const out: Raw = { ...raw }
  const compact = options.compact
  if (compact === 'off') out.compact = { ...block(out.compact), enabled: false }
  else if (compact === 'request' || compact === 'policy' || compact === 'both') {
    out.compact = { ...block(out.compact), enabled: true, trigger: compact }
  }
  const fallback = options.modelFallback
  if (fallback === 'on' || fallback === 'off') {
    out.modelFallback = { ...block(out.modelFallback), enabled: fallback === 'on' }
  }
  const band = options.band
  if (band === 'on' || band === 'off') out.ui = { ...block(out.ui), band: band === 'on' }
  return out
}
