export type Failure =
  | { kind: 'usage'; text: string; model: string | null }
  | { kind: 'overload'; text: string }
  | { kind: 'interrupted'; text: string }
  | { kind: 'safeguard'; text: string }

/**
 * Limits that cover every model: switching models would not help, so these
 * always wait for the reset.
 */
const ACCOUNT_WIDE = new Set([
  'session', 'weekly', 'monthly', 'usage', 'fast', 'spend', 'credit', 'channel', 'team',
])

/**
 * The model a limit is scoped to, from Claude Code's banner: "You've hit your
 * Opus limit · resets Oct 9, 10am", "You've reached your Fable limit. Run
 * /usage-credits ...". Null for an account-wide limit.
 */
export function scopedModel(text: string): string | null {
  const m = /(?:hit|reached) your ([A-Za-z][\w.-]*) limit/i.exec(text)
  const name = m?.[1]
  if (name === undefined || ACCOUNT_WIDE.has(name.toLowerCase())) return null
  return name
}

/**
 * Every truncated-stream message Claude Code writes ends with one of these.
 * They all come from one stream finalizer and carry `error: server_error`,
 * so the text is what tells them from a real 5xx.
 */
const INTERRUPTED = /The response above may be incomplete\.|before a response was produced\. Try again\.|and no response was produced\. Try again\./

const SAFEGUARD = /safeguards flagged this message/

const USAGE = /(?:hit|reached) your [\w.-]+ limit|usage limit reached|out of (?:extra )?usage|limit reached\s*[·-]\s*resets/i

const API_LIMITED = /temporarily limiting requests/

/**
 * One failed turn, from what Claude Code reported: the StopFailure `error`
 * kind when the classic event carried one, and the error message it showed.
 * Null for a failure retrying cannot fix (auth, billing, a bad request).
 */
export function classify(error: string | null, text: string, customPatterns: readonly string[] = []): Failure | null {
  if (customPatterns.some((p) => new RegExp(p, 'i').test(text))) return { kind: 'usage', text, model: null }
  if (SAFEGUARD.test(text)) return { kind: 'safeguard', text }
  if (INTERRUPTED.test(text)) return { kind: 'interrupted', text }
  if (error === 'rate_limit' || (error === null && USAGE.test(text))) {
    if (API_LIMITED.test(text)) return { kind: 'overload', text }
    return { kind: 'usage', text, model: scopedModel(text) }
  }
  if (error === 'overloaded' || error === 'server_error') return { kind: 'overload', text }
  if (error === null && /^API Error: (?:5\d\d|529|429)\b|overloaded_error|temporarily limiting requests/m.test(text)) {
    return { kind: 'overload', text }
  }
  return null
}
