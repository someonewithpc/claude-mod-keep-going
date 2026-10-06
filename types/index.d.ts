export type KeepGoingRetryFamily = 'overload' | 'safeguard' | 'interrupted'

/**
 * What Claude Code's own auto-continue said about this limit: armed for the
 * reset, fired, waiting for Enter (stale), or not going to continue.
 */
export type KeepGoingNativeNotice = 'armed' | 'fired' | 'stale' | 'disabled'

export type KeepGoingUsageWait = {
  until: number
  enteredAt: number
  isFallback: boolean
  attempts: number
  banner: string
  submittedAt: number
  nativeNotice: KeepGoingNativeNotice | null
  nativeNoticeAt: number
  hasLoggedGrace: boolean
  hasLoggedMissed: boolean
  networkDownSince: number
  isGivenUp: boolean
}

export type KeepGoingRetry = {
  family: KeepGoingRetryFamily
  attempts: number
  until: number
  startedAt: number
  totalWaitMs: number
  lastSentAt: number
  isAwaitingResult: boolean
  isGivenUp: boolean
  detail: string
}

export type KeepGoingFallback = {
  from: string
  to: string
  original: string
  resetAt: number
  phase: 'switch' | 'continue' | 'active' | 'restore'
}

export type KeepGoingCompact = {
  request: { at: number; focus: string } | null
  lastSentAt: number
  handledIdleSince: number
  lastMatchedAnswer: string | null
  scheduledFor: number
  reportedIdleSince: number
}

export type KeepGoingActivity = {
  isBusy: boolean
  turnStartedAt: number
  idleSince: number
  lastUserAt: number
  background: number | null
  crons: number
  permissionAt: number
  lastAnswer: string
  failureTurnStartedAt: number
  /** The model the session was on when it went idle; another one now means a cold cache. */
  idleModel: string
  lastEditAt: number
}

/** Scheduled work the session is waiting on, from the tool calls that set it up. */
export type KeepGoingScheduled = {
  recurringCrons: number
  oneShotCrons: number
  wakeUntil: number
  workflows: number
}

export type KeepGoingCore = {
  usage: KeepGoingUsageWait | null
  retry: KeepGoingRetry | null
  fallback: KeepGoingFallback | null
  wrapUp: { noticeAt: number; dueAt: number; nudges: number }
  compact: KeepGoingCompact
  activity: KeepGoingActivity
  scheduled: KeepGoingScheduled
  isPaused: boolean
  cacheTtlMs: number | null
}

export type KeepGoingView = {
  line: string | null
  detail: string | null
  actions: readonly ('continue' | 'cancel' | 'compact' | 'skip')[]
}

declare module 'claude-code' {
  interface PluginState {
    'keep-going': { core: KeepGoingCore | null; view: KeepGoingView | null }
  }
}
