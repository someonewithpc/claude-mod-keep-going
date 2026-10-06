import { read } from 'claude-code'
import type { Register } from 'claude-code'

import { applyOptions, mergeFiles, validate } from './config'
import { backgroundOf, isPersonPrompt, Keeper } from './keeper'

const TOOL = 'request_compact'
const TOOL_NAME = 'mcp__keep-going__request_compact'
const MAX_LOG_LINES = 2000

const WRAP_UP = /Approaching your [\w-]+(?: usage)? limit|\[Usage limit approaching\. Checkpoint now/

const HELP = [
  '/keep-going [status]       what is pending in this session',
  '/keep-going continue       send the pending continue now',
  '/keep-going cancel         drop the pending continue or compaction',
  '/keep-going compact [what] compact once idle, keeping what you name',
  '/keep-going pause|resume   stop or restart acting in this session',
].join('\n')

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: unknown; text?: unknown }) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

export const register: Register = (on, options) => {
  const lines: string[] = []
  let logPath = ''
  let isLogDirty = false
  let uiLog: ((text: string, toTranscript: boolean) => void) | null = null
  let flushLog: () => Promise<void> = async () => {}
  let badgePath = ''

  const write = (level: string, line: string, toTranscript: boolean) => {
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    lines.push(`[${stamp}] [${level}] ${line}`)
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
    isLogDirty = true
    uiLog?.(line, toTranscript)
  }

  const keeper = new Keeper({
    info: (line) => write('INFO', line, false),
    warn: (line) => write('WARN', line, false),
    notice: (line) => write('INFO', line, true),
  })

  on('session.start', async ($, e, next) => {
    const CORE = { plugin: 'keep-going', key: 'core' } as const
    const VIEW = { plugin: 'keep-going', key: 'view' } as const
    uiLog = (text, toTranscript) => $.ui.log(text, { to: toTranscript ? 'transcript' : 'debug' })
    flushLog = async () => {
      if (!isLogDirty || logPath === '') return
      isLogDirty = false
      try {
        await $.fs.write(logPath, `${lines.join('\n')}\n`)
      } catch {
        isLogDirty = true
      }
    }
    keeper.io = {
      now: () => $.clock.now(),
      saveState: async (core, view) => {
        await $.state.set(CORE, core)
        if (view !== null) await $.state.set(VIEW, view)
      },
      loadCore: async () => (await $.state.get(CORE)).value,
      status: (text) => $.ui.status(text),
      writeBadge: (badge) => $.fs.write(badgePath, badge === '' ? '' : `${badge}\n`),
      storeGet: (key) => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeKeys: () => $.store.keys(),
      storeDelete: (key) => $.store.delete(key),
      rateLimits: async () => (await $.session.usage()).rateLimits,
      context: async () => {
        const usage = await $.session.usage()
        return {
          percent: usage.context.percent ?? null,
          tokens: usage.context.tokens ?? null,
          isSubscription: usage.rateLimits.length > 0,
        }
      },
      model: () => $.session.model(),
      lastAssistantText: async () => {
        const last = (await $.session.messages()).at(-1)
        return last?.role === 'assistant' ? last.text : ''
      },
      busyAgents: async () => (await $.agent.list())
        .filter((agent) => agent.status === 'pending' || agent.status === 'running').length,
      submit: async (text) => {
        await $.prompt.submit({ text, asUser: true })
      },
      compact: async (focus) => {
        const result = await $.session.compact(focus ? { instructions: focus } : {})
        return result && 'skip' in result && typeof result.skip === 'string' ? result.skip : null
      },
      isReachable: (url, timeoutMs) => Promise.race([
        $.http.fetch(url, { method: 'HEAD' }).then(() => true, () => false),
        $.clock.sleep(timeoutMs).then(() => false, () => false),
      ]),
      after: (ms, fn) => {
        $.clock.after(ms, fn)
      },
    }
    const home = (await $.env.get('HOME')) ?? ''
    const configHome = (await $.env.get('XDG_CONFIG_HOME')) || `${home}/.config`
    const configDirs = ((await $.env.get('XDG_CONFIG_DIRS')) || '/etc/xdg').split(':').filter(Boolean)
    const stateHome = (await $.env.get('XDG_STATE_HOME')) || `${home}/.local/state`
    const runtimeDir = (await $.env.get('XDG_RUNTIME_DIR')) || '/tmp'

    const files = []
    for (const path of [...[...configDirs].reverse().map((dir) => `${dir}/claude-keep-going/config.json`), `${configHome}/claude-keep-going/config.json`]) {
      files.push(parsed(await $.fs.read(path).catch(() => '')))
    }
    keeper.config = validate(applyOptions(mergeFiles(files), options))

    const sessionId = await $.session.id()
    const day = new Date().toISOString().slice(0, 10)
    logPath = `${stateHome}/claude-keep-going/logs/mod-${day}-${sessionId.slice(0, 8)}.log`
    badgePath = `${runtimeDir}/claude-keep-going/badge/${sessionId}`
    await keeper.restore(sessionId)

    try {
      await $.command.register({
        name: 'keep-going',
        description: 'Show or act on what keep-going has pending: continue, cancel, compact, pause',
        argumentHint: '[status|continue|cancel|compact [focus]|pause|resume]',
        immediate: true,
      })
    } catch (error) {
      write('WARN', `could not register /keep-going: ${String(error)}`, false)
    }

    const c = keeper.config.compact
    if (c.enabled && c.trigger !== 'policy') {
      try {
        await $.tool.register({
          name: TOOL,
          description:
            'Ask for this conversation to be compacted once it has been idle a while, before the prompt cache '
            + 'expires. Call it when you finish a large piece of work and what comes next does not need the '
            + 'details of it. Nothing happens while work is still running. `focus` names what the summary should keep.',
          inputSchema: {
            type: 'object',
            properties: { focus: { type: 'string', description: 'What the summary should keep or stress' } },
          },
        })
      } catch (error) {
        write('WARN', `could not register the ${TOOL} tool: ${String(error)}`, false)
      }
    }

    $.clock.every(keeper.config.tickSeconds * 1000, () => {
      void keeper.tick().then(() => flushLog())
    })
    void keeper.sweepStore().catch(() => {})
    write('INFO', `watching session ${sessionId.slice(0, 8)} (${e.isInteractive ? 'interactive' : 'headless'})`, false)
    await keeper.save()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flushLog()
    if (badgePath !== '') await $.fs.write(badgePath, '').catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await keeper.onTurnStart()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await keeper.onTurnComplete(e.reason, e.answer)
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await keeper.onStopFailure(e.error, e.last_assistant_message ?? e.error_details ?? '')
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    keeper.onStop(backgroundOf(e.background_tasks), e.session_crons?.length ?? 0)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    keeper.onNotification(await $.clock.now(), e.notification_type)
    await keeper.save()
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    keeper.core.cacheTtlMs = e.cache_ttl === '1h' ? 3600_000 : 300_000
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const model = keeper.stepModel(e.model, Date.now())
    return yield* next(model === null ? e : { ...e, model })
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await keeper.onMeasure()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isPersonPrompt(e.origin.kind)) await keeper.onPersonPrompt()
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    if (keeper.config.compact.awayMinutes !== null) keeper.core.activity.lastUserAt = await $.clock.now()
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.door !== 'response' && e.door !== 'tool-result' && e.door !== 'prompt') {
      const content = (e.message as { content?: unknown }).content
      if (WRAP_UP.test(textOf(content))) keeper.onWrapUpNotice(await $.clock.now())
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    const focus = typeof e.focus === 'string' ? e.focus : ''
    return { result: await keeper.requestCompact(focus) }
  })

  on('command.run', { command: 'keep-going' }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (verb) {
      case 'status': {
        const view = (await $.state.get({ plugin: 'keep-going', key: 'view' } as const)).value
        const pending = view?.line ?? 'nothing pending'
        return { text: `${pending}${view?.detail ? `\n${view.detail}` : ''}\n\n${HELP}` }
      }
      case 'continue':
        return { text: await keeper.continueNow() }
      case 'cancel':
        return { text: await keeper.cancel() }
      case 'compact':
        return { text: await keeper.requestCompact(rest.join(' ')) }
      case 'pause':
        keeper.core.isPaused = true
        await keeper.save()
        return { text: 'keep-going is paused for this session.' }
      case 'resume':
        keeper.core.isPaused = false
        await keeper.save()
        return { text: 'keep-going is watching this session again.' }
      case 'debug':
        return { text: JSON.stringify({ core: keeper.core, config: keeper.config }, null, 2) }
      case 'log':
        return { text: lines.slice(-20).join('\n') || 'Nothing logged yet.' }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!keeper.config.ui.band || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const view = await read($, { plugin: 'keep-going', key: 'view' } as const)
    if (view === null || view === undefined || view.actions.length === 0 || view.line === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const act = (what: 'continue' | 'cancel' | 'compact' | 'skip') => async () => {
      if (what === 'continue') await keeper.continueNow()
      else if (what === 'compact') {
        keeper.core.compact.scheduledFor = 0
        keeper.core.compact.handledIdleSince = keeper.core.activity.idleSince
        await keeper.compactNow(keeper.core.compact.request?.focus ?? keeper.config.compact.focus, 'from the band')
        keeper.core.compact.request = null
        await keeper.save()
      } else await keeper.cancel()
    }
    const labels = { continue: 'Continue now', cancel: 'Cancel', compact: 'Compact now', skip: 'Skip' } as const

    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>keep-going: {view.line}</Text>
        {view.actions.map((what) => (
          <Button key={what} label={labels[what]} plain onPress={act(what)} />
        ))}
      </Box>
    )
  })
}
