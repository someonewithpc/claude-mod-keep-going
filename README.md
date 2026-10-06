# keep-going

A Claude Code mod that keeps unattended sessions going through usage limits, API
errors and full contexts.

Leave Claude Code working overnight and something usually stops it: the session
limit, an overloaded API, a response cut off by a dropped connection. keep-going
does what you would do if you were there. It waits for the limit to reset and
sends "continue", retries API errors with backoff, resumes cut-off responses,
and compacts an idle session before its prompt cache expires.

It replaces [claude-keep-going](https://github.com/someonewithpc/claude-keep-going),
which did the same from outside Claude Code by watching a tmux pane. As a mod it
runs inside Claude Code: it reads the turn's own result instead of the screen,
and sends prompts and compactions through the mod API instead of typing keys.
It needs no tmux, no settings hooks and no background process.

## Install

Needs Claude Code 2.1.287 or later. At the Claude Code prompt:

```
/plugin install keep-going --marketplace someonewithpc/claude-mod-keep-going
```

Answer `y` to add the marketplace, then pick a scope. It is active right away.

To load a checkout for one session instead: `claude --plugin-dir ./claude-mod-keep-going`.

With Nix, the flake has NixOS and home-manager modules:

```nix
inputs.claude-mod-keep-going.url = "github:someonewithpc/claude-mod-keep-going";
# with claude-mod-keep-going.nixosModules.default (or .homeManagerModules.default) imported:
programs.claude-mod-keep-going = {
  enable = true;
  settings.compact = { enabled = true; trigger = "both"; };
};
```

The module puts the mod's store path in `CLAUDE_CODE_PLUGIN_DIRS` and writes
`settings` to the config file below.

## What it does

**Usage limits.** When a turn ends on "You've hit your session limit · resets
3:50pm (Europe/Lisbon)", it waits until the reset plus `marginSeconds` and sends
`retryMessage`. The reset time comes from the rate-limit windows Claude Code
reports. Failing that, it reads the time off the message (time zones and DST
included), and failing that it waits `fallbackWaitHours`.

Claude Code can continue on its own after a limit. With `native.usageLimit:
"defer"` (the default), keep-going gives it `native.graceSeconds` past the reset
before it sends anything. Before sending, it checks that the API answers, for
up to `networkCheck.maxWaitMinutes`, so a laptop that just woke up doesn't burn
a retry. It stops after `maxRetries` continues that hit the limit again.

**One-model limits** (opt-in). On "You've hit your Opus limit", it sends that
model's requests to the one `modelFallback.map` names until the limit resets,
then lets them go back. It rewrites each request, for subagents too, and leaves
`/model` and your saved default alone.

**API errors.** A 529, a 5xx or the API-level 429 ("Server is temporarily
limiting requests") gets retried on an exponential schedule with full jitter, up
to `maxRetries` and `overload.maxTotalWaitMinutes` in all. Claude Code has
already retried the request itself by then, so this covers outages that last
minutes, not seconds.

**Cut-off responses.** "Connection lost mid-response", "Your computer went to
sleep mid-response" and the other truncated-stream errors get one `continue`
after `streamInterrupted.retryDelaySeconds`, up to `streamInterrupted.maxRetries`.

**Safeguard false positives.** A turn the safeguards flagged gets re-sent a few
times (`safeguard.maxRetries`).

**Near-limit wrap-up.** At about 95% of the 5-hour window Claude Code tells the
model to wrap up, and the model stops with a list of what's left. keep-going
sends one `continue` after that so work runs on to the real limit.

**Idle compaction** (opt-in). A compaction re-reads the whole context once.
While the prompt cache is warm that read is cheap; after it expires the next
message re-sends everything at full price anyway. So keep-going compacts an idle
session `compact.settle.marginSeconds` before the cache expires, when:

- Claude asked for it with the `request_compact` tool, or you did with
  `/keep-going compact`, and `compact.trigger` is `request` or `both`
- the context is over `compact.minContextPercent` and `compact.minContextTokens`,
  and `compact.trigger` is `policy` or `both`
- Claude's last message mentions `/compact`, with `compact.matchLastMessage`

It waits for running subagents first unless `compact.waitForAgents` is false,
and can be limited to a time window (`compact.window`) or to sessions nobody
has typed in for `compact.awayMinutes`. Compacting never touches what you have
typed in the prompt box.

## Seeing what it does

While something is pending, a line above the prompt says what and when, with
buttons to act now or cancel:

```
keep-going: usage limit, continuing at 15:51 (in 1h20m)  Continue now  Cancel
```

What it does shows up in the transcript as dim lines, and every decision goes to
`$XDG_STATE_HOME/claude-keep-going/logs/mod-<date>-<session>.log`.

`/keep-going` takes these:

| Command | |
|---|---|
| `/keep-going` | what is pending |
| `/keep-going continue` | send the pending continue now |
| `/keep-going cancel` | drop the pending continue or compaction |
| `/keep-going compact [focus]` | compact once idle, keeping `focus` |
| `/keep-going pause`, `resume` | stop or restart acting in this session |
| `/keep-going log` | the last 20 log lines |

A wait survives a restart: `claude --continue` picks it up again.

## Configuration

keep-going reads `/etc/xdg/claude-keep-going/config.json` (or each
`$XDG_CONFIG_DIRS` entry), then `~/.config/claude-keep-going/config.json` on top,
merged one level deep. These are the paths claude-keep-going used, so an
existing config keeps working; keys that only made sense for screen scraping
are ignored. Three switches are also rows in `/config`: idle compaction, model
fallback and the band above the prompt.

```jsonc
{
  "maxRetries": 5,
  "marginSeconds": 60,
  "fallbackWaitHours": 5,
  "retryMessage": "Continue where you left off. The previous attempt was rate limited.",
  "customPatterns": [],            // extra regexes that mark an error as a usage limit
  "native": { "usageLimit": "defer", "graceSeconds": 180 },
  "networkCheck": { "enabled": true, "url": "https://api.anthropic.com/", "maxWaitMinutes": 10 },
  "overload": {
    "enabled": true,
    "backoffSeconds": [30, 60, 120, 240, 300],
    "steadyStateSeconds": 300,
    "jitterMode": "full",          // or "proportional", with jitterPct
    "jitterPct": 15,
    "maxTotalWaitMinutes": 120,
    "retryMessage": "Continue where you left off."
  },
  "safeguard": { "enabled": true, "maxRetries": 3, "retryDelaySeconds": 8, "retryMessage": "continue" },
  "streamInterrupted": { "enabled": true, "maxRetries": 2, "retryDelaySeconds": 5, "retryMessage": "continue" },
  "nearLimitWrapUp": { "enabled": true, "maxRetries": 3, "retryMessage": "continue" },
  "modelFallback": { "enabled": false, "map": { "Opus": "sonnet" } },
  "compact": {
    "enabled": false,
    "trigger": "request",          // "request", "policy" or "both"
    "minContextPercent": 40,
    "minContextTokens": null,
    "settle": { "mode": "before-expiry", "marginSeconds": 300, "minutes": 4 },
    "cacheTtlMinutes": null,       // null: 60 on a subscription, 5 on an API key
    "focus": "",
    "matchLastMessage": false,
    "minIntervalMinutes": 30,
    "waitForAgents": true,
    "window": null,                // { "start": "22:00", "end": "06:00" }
    "awayMinutes": null
  },
  "ui": { "statusLine": "active", "band": true }
}
```

## What it doesn't do

- **Keep the process alive.** A mod lives inside Claude Code, so it stops when
  Claude Code exits. To survive a dropped SSH session or a closed terminal, run
  Claude Code in tmux or screen.
- **`claude -p`.** A print-mode run ends after one result, so there is nothing
  to continue.
- **Sessions where mods are off**: `--safe-mode`, `disableAllHooks`, or an
  organization that allows managed mods only.

## Development

```bash
claude plugin validate .
claude plugin test .                    # the mod, against the engine
node --test tests/node/*.test.mjs       # the reset-time parser, across time zones
```

`hooks/register.tsx` wires Claude Code's events to `hooks/keeper.ts`, which holds
the state and decides what to do. Its engine calls go through an `io` object of
closures, so `tests/keeper.test.ts` drives it on a fake clock.

## License

MIT
