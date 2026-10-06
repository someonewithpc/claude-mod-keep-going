import type { Config } from './config'
import type { KeepGoingCore, KeepGoingView } from '../types'

export function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function durationOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

const RETRY_LABEL = {
  overload: 'API error',
  safeguard: 'Safeguard flag',
  interrupted: 'Response cut off',
} as const

/**
 * What the status line and the band show: one line for the most pressing
 * thing pending, null when there is nothing to say.
 */
export function viewOf(core: KeepGoingCore, config: Config, now: number): KeepGoingView {
  if (core.isPaused) return { line: 'paused for this session', detail: null, actions: [] }

  const u = core.usage
  if (u !== null) {
    if (u.isGivenUp) {
      return { line: `gave up after ${u.attempts} continues`, detail: u.banner, actions: ['continue', 'cancel'] }
    }
    if (now < u.until) {
      const line = u.attempts === 0
        ? `usage limit, continuing at ${clockOf(u.until)} (in ${durationOf(u.until - now)})`
        : `continue ${u.attempts}/${config.maxRetries} sent, checking again at ${clockOf(u.until)}`
      return { line, detail: u.banner, actions: ['continue', 'cancel'] }
    }
    return { line: 'usage limit reset, continuing', detail: u.banner, actions: ['continue', 'cancel'] }
  }

  const f = core.fallback
  if (f !== null && f.phase === 'active') {
    return { line: `${f.from} limit, on ${f.to} until ${clockOf(f.resetAt)}`, detail: null, actions: [] }
  }

  const r = core.retry
  if (r !== null) {
    const label = RETRY_LABEL[r.family]
    if (r.isGivenUp) return { line: `${label}: gave up after ${r.attempts} retries`, detail: r.detail, actions: ['continue', 'cancel'] }
    if (r.isAwaitingResult) return { line: `${label}: retry ${r.attempts} sent`, detail: r.detail, actions: ['cancel'] }
    return {
      line: `${label}: retry ${r.attempts + 1} in ${durationOf(r.until - now)}`,
      detail: r.detail,
      actions: ['continue', 'cancel'],
    }
  }

  const c = core.compact
  if (c.scheduledFor > now && c.scheduledFor !== 0) {
    return { line: `compacting at ${clockOf(c.scheduledFor)}`, detail: null, actions: ['compact', 'skip'] }
  }

  return { line: config.ui.statusLine === 'always' ? 'watching' : null, detail: null, actions: [] }
}

/**
 * The short badge a statusline script can show beside its own fields, as
 * claude-keep-going's tmux and statusline badge did: 🟢KG while watching,
 * a countdown while something is pending.
 */
export function badgeOf(core: KeepGoingCore, now: number): string {
  if (core.isPaused) return '⏸KG'
  const u = core.usage
  if (u !== null) {
    if (u.isGivenUp) return '🔴KG'
    const left = Math.max(0, u.until - now)
    const minutes = Math.floor(left / 60_000)
    return minutes >= 60
      ? `⏳KG ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
      : `⏳KG ${minutes}m`
  }
  if (core.fallback !== null && core.fallback.phase !== 'switch') return '🔀KG'
  const r = core.retry
  if (r !== null) {
    if (r.isGivenUp) return '🔴KG'
    const icon = r.family === 'overload' ? '🟠' : r.family === 'safeguard' ? '🛡' : '🔁'
    return r.isAwaitingResult ? `${icon}KG` : `${icon}KG ${Math.max(0, Math.round((r.until - now) / 1000))}s`
  }
  const at = core.compact.scheduledFor
  if (at > now) return `🟢KG 🗜${Math.ceil((at - now) / 60_000)}m`
  return '🟢KG'
}
