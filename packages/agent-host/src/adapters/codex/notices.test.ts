import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { normalizeNotification, threadSettingsChanged, threadSettingsOf } from './normalize.js'

/**
 * What Codex tells the person (#304): warnings, a model it answered with instead, an MCP server that did not start, a
 * thread whose settings changed under it. The payloads marked "measured" are copied from `codex app-server` 0.160.0
 * (gpt-5.6-luna, low effort, a temp folder, 2026-10-04); the rest use the generated bindings of the same version.
 */

const state = vi.hoisted(() => ({
  handlers: [] as { onNotification: (n: { method: string; params?: unknown }) => void }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers.push(handlers)
    }
    request(method: string): Promise<unknown> {
      // The thread/start answer carries the settings the thread runs with (measured: model, reasoningEffort, serviceTier)
      if (method === 'thread/start') {
        return Promise.resolve({ thread: { id: 't1' }, model: 'gpt-5.6-luna', reasoningEffort: 'low', serviceTier: 'priority' })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const S = 'sess-1'
const n = (method: string, params?: unknown) => normalizeNotification(S, { method, params })

/** The measured text of an unknown `config.toml` key (the person's paths shortened) */
const CONFIG_TEXT =
  'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
  '  user (~/.codex/config.toml): `mcp_servers.plane.type` is ignored.\n' +
  '  user (~/.codex/config.toml): `mcp_servers.playwright.type` is ignored.'

/** The readable parts of CONFIG_TEXT (#342) */
const CONFIG_WORDS = {
  from: 'Codex',
  label: 'config warning',
  audience: 'you',
  summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
  items: ['mcp_servers.plane.type', 'mcp_servers.playwright.type'],
  hint: 'Codex already runs without them; removing them from the file only silences this notice.',
}

async function session(opts: { model?: string; effort?: string } = {}) {
  const events: NormalizedEvent[] = []
  await new CodexAdapter().createSession({ sessionId: S, cwd: '/tmp', permissionPreset: 'normal', ...opts }, (e) => events.push(e))
  return { events, notify: state.handlers.at(-1)!.onNotification }
}

describe('codex notices (#304)', () => {
  it('a configuration warning and its per-thread twin become notices kept once per session (measured)', () => {
    const notice = { type: 'notice', sessionId: S, level: 'warning', text: CONFIG_TEXT, oncePerSession: true, ...CONFIG_WORDS }
    expect(n('configWarning', { summary: CONFIG_TEXT, details: null })).toEqual([notice])
    // The thread's twin reads the same, so whichever is stored first (configWarning) is the line (#342)
    expect(n('warning', { threadId: 't1', message: CONFIG_TEXT })).toEqual([{ ...notice, label: 'warning' }])
  })

  it('a deprecation notice carries its guidance, and a guardian warning is said every time', () => {
    expect(n('deprecationNotice', { summary: '`foo` is deprecated.', details: 'Use `bar` instead.' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: '`foo` is deprecated.\nUse `bar` instead.', oncePerSession: true, from: 'Codex', label: 'deprecation' },
    ])
    expect(n('guardianWarning', { threadId: 't1', message: 'This command reaches outside the workspace.' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: 'This command reaches outside the workspace.', from: 'Codex', label: 'auto-review warning' },
    ])
  })

  it('a rerouted turn says which model answered and why, and leaves the settings alone', () => {
    expect(
      n('model/rerouted', { threadId: 't1', turnId: 'u1', fromModel: 'gpt-5.6', toModel: 'gpt-5.6-mini', reason: 'highRiskCyberActivity' }),
    ).toEqual([
      {
        type: 'notice',
        sessionId: S,
        level: 'warning',
        text: 'Codex answered this turn with gpt-5.6-mini instead of gpt-5.6 because it was flagged as high-risk cyber activity',
        from: 'Codex',
        label: 'model rerouted',
      },
    ])
  })

  it('an MCP server that failed to start becomes a notice in its own words; starting and ready say nothing (measured)', () => {
    const failed = {
      threadId: 't1', name: 'cc304_broken', status: 'failed', failureReason: null,
      error: 'MCP client for `cc304_broken` failed to start: MCP startup failed: No such file or directory (os error 2)',
    }
    const words = { from: 'Codex', label: 'MCP server', audience: 'you' }
    expect(n('mcpServer/startupStatus/updated', failed)).toEqual([{ type: 'notice', sessionId: S, level: 'warning', text: failed.error, ...words }])
    expect(n('mcpServer/startupStatus/updated', { ...failed, status: 'starting', error: null })).toEqual([])
    expect(n('mcpServer/startupStatus/updated', { ...failed, status: 'ready', error: null })).toEqual([])
    expect(n('mcpServer/startupStatus/updated', { ...failed, error: null, failureReason: 'reauthenticationRequired' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: 'MCP server `cc304_broken` failed to start (it needs you to sign in again)', ...words },
    ])
  })

  it('thread settings changes are measured against what the thread said it runs with, not what was asked', () => {
    const before = threadSettingsOf({ thread: { id: 't1' }, model: 'gpt-5.6-luna', reasoningEffort: 'low', serviceTier: 'priority' })
    expect(before).toEqual({ model: 'gpt-5.6-luna', effort: 'low', serviceTier: 'priority' })
    const launched = { model: null, effort: null, verbosity: 'low', serviceTier: null }
    const settings = (model: string, effort: string) => ({ threadId: 't1', threadSettings: { model, effort, serviceTier: 'priority', cwd: '/tmp' } })

    // The same settings (Codex's concrete answer for a default) are no change
    expect(threadSettingsChanged(S, before, settings('gpt-5.6-luna', 'low'), launched).events).toEqual([])
    const { next, events } = threadSettingsChanged(S, before, settings('gpt-5.6', 'low'), launched)
    expect(next).toEqual({ model: 'gpt-5.6', effort: 'low', serviceTier: 'priority' })
    expect(events).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: "This thread's settings were changed outside Centralu: model gpt-5.6-luna → gpt-5.6", from: 'Codex', label: 'thread settings' },
      { type: 'settings_changed', sessionId: S, model: 'gpt-5.6', effort: null, verbosity: 'low', serviceTier: null, by: 'tool' },
    ])
  })
})

describe('codex notices in a session (#304)', () => {
  it('a server that fails twice on one start is said once, and again only after it started in between (measured)', async () => {
    const { events, notify } = await session()
    const status = (s: string) => notify({
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 't1', name: 'cc304_exits', status: s, failureReason: null, error: s === 'failed' ? 'MCP client for `cc304_exits` failed to start' : null },
    })
    for (const s of ['starting', 'failed', 'starting', 'failed']) status(s)
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1)
    status('starting')
    status('ready')
    status('failed')
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(2)
  })

  it("a child thread's warning stays out of the parent's conversation", async () => {
    const { events, notify } = await session()
    notify({ method: 'warning', params: { threadId: 'child-thread', message: CONFIG_TEXT } })
    notify({ method: 'warning', params: { threadId: 't1', message: CONFIG_TEXT } })
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1)
  })

  it('a thread whose model changed under it reports the switch against what thread/start answered', async () => {
    const { events, notify } = await session({ effort: 'high' })
    const updated = (model: string) => notify({
      method: 'thread/settings/updated',
      params: { threadId: 't1', threadSettings: { model, effort: 'low', serviceTier: 'priority' } },
    })
    updated('gpt-5.6-luna')
    expect(events).toEqual([])
    updated('gpt-5.6')
    expect(events).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: "This thread's settings were changed outside Centralu: model gpt-5.6-luna → gpt-5.6", from: 'Codex', label: 'thread settings' },
      { type: 'settings_changed', sessionId: S, model: 'gpt-5.6', effort: 'high', verbosity: null, serviceTier: null, by: 'tool' },
    ])
  })
})

/*
 * Readable notices (#342): who is speaking, what kind, who has to act, and a plain explanation first for the ones we
 * know. The hydration wordings are copied from the codex-cli 0.160.0 binary (resume and fork share the first, `thread/read`
 * has the second); the first is what the owner's screen showed (issue #342).
 */
describe('readable codex notices (#342)', () => {
  const only = (method: string, params: unknown) => {
    const [e] = n(method, params)
    if (e?.type !== 'notice') throw new Error(`no notice for ${method}`)
    const { from, label, audience, summary, items, hint } = e
    return { from, label, audience, summary, items, hint }
  }

  it('the unknown-key warning names the file with ~ and lists one setting per line, singular when it is one', () => {
    const home = homedir()
    const text =
      'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n' +
      `  user (${home}/.codex/config.toml): \`model_reasoning_summary_format\` is ignored.`
    expect(only('configWarning', { summary: text, details: null })).toEqual({
      from: 'Codex',
      label: 'config warning',
      audience: 'you',
      summary: 'Codex ignored 1 setting in `~/.codex/config.toml`',
      items: ['model_reasoning_summary_format'],
      hint: 'Codex already runs without it; removing it from the file only silences this notice.',
    })
  })

  it('settings ignored in two files are listed with their file', () => {
    const text =
      'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
      '  user (~/.codex/config.toml): `a.b` is ignored.\n' +
      '  project (/work/app/.codex/config.toml): `c` is ignored.'
    expect(only('configWarning', { summary: text, details: null })).toMatchObject({
      audience: 'you',
      summary: 'Codex ignored 2 settings in 2 config files',
      items: ['a.b (~/.codex/config.toml)', 'c (/work/app/.codex/config.toml)'],
    })
  })

  it('the full-history deprecation is for Centralu, with nothing for the person to do, in both wordings', () => {
    for (const summary of [
      'Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.',
      'Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`.',
    ]) {
      expect(only('deprecationNotice', { summary, details: null })).toEqual({
        from: 'Codex',
        label: 'deprecation',
        audience: 'centralu',
        summary: 'Codex says Centralu loads thread history in an outdated way',
        items: undefined,
        hint: 'Nothing to do on your side; Centralu will switch to the paginated API (#342).',
      })
    }
  })

  it("an unknown deprecation keeps Codex's words; it is for Centralu when it names an API method, for you when it names config", () => {
    const api = only('deprecationNotice', {
      summary: 'review/start with delivery "detached" is deprecated and will be removed in a future release.',
      details: null,
    })
    expect(api).toEqual({ from: 'Codex', label: 'deprecation', audience: 'centralu', summary: undefined, items: undefined, hint: undefined })
    const config = only('deprecationNotice', {
      summary: '`[features].transcript_v2` is deprecated and ignored.',
      details: 'Use `[tui].fullscreen_transcript` in config.toml instead.',
    })
    expect(config).toMatchObject({ audience: 'you', summary: undefined })
    expect(only('deprecationNotice', { summary: 'Something else is going away.', details: null }).audience).toBeUndefined()
  })

  it("an MCP server that failed is the person's when they configured it, Centralu's for its own bridge, unsaid for an app", () => {
    const failed = (name: string) => ({ threadId: 't1', name, status: 'failed', failureReason: null, error: `MCP client for \`${name}\` failed to start` })
    expect(only('mcpServer/startupStatus/updated', failed('playwright')).audience).toBe('you')
    expect(only('mcpServer/startupStatus/updated', failed('centralu')).audience).toBe('centralu')
    expect(only('mcpServer/startupStatus/updated', failed('app-notes')).audience).toBeUndefined()
  })

  it('a warning that is not the unknown-key one is shown as it is, with its kind', () => {
    expect(only('warning', { threadId: 't1', message: 'Exceeded skills context budget.' })).toEqual({
      from: 'Codex',
      label: 'warning',
      audience: undefined,
      summary: undefined,
      items: undefined,
      hint: undefined,
    })
  })
})
