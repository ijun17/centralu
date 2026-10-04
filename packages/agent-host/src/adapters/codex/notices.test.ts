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

async function session(opts: { model?: string; effort?: string } = {}) {
  const events: NormalizedEvent[] = []
  await new CodexAdapter().createSession({ sessionId: S, cwd: '/tmp', permissionPreset: 'normal', ...opts }, (e) => events.push(e))
  return { events, notify: state.handlers.at(-1)!.onNotification }
}

describe('codex notices (#304)', () => {
  it('a configuration warning and its per-thread twin become notices kept once per session (measured)', () => {
    const notice = { type: 'notice', sessionId: S, level: 'warning', text: CONFIG_TEXT, oncePerSession: true }
    expect(n('configWarning', { summary: CONFIG_TEXT, details: null })).toEqual([notice])
    expect(n('warning', { threadId: 't1', message: CONFIG_TEXT })).toEqual([notice])
  })

  it('a deprecation notice carries its guidance, and a guardian warning is said every time', () => {
    expect(n('deprecationNotice', { summary: '`foo` is deprecated.', details: 'Use `bar` instead.' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: '`foo` is deprecated.\nUse `bar` instead.', oncePerSession: true },
    ])
    expect(n('guardianWarning', { threadId: 't1', message: 'This command reaches outside the workspace.' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: 'This command reaches outside the workspace.' },
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
      },
    ])
  })

  it('an MCP server that failed to start becomes a notice in its own words; starting and ready say nothing (measured)', () => {
    const failed = {
      threadId: 't1', name: 'cc304_broken', status: 'failed', failureReason: null,
      error: 'MCP client for `cc304_broken` failed to start: MCP startup failed: No such file or directory (os error 2)',
    }
    expect(n('mcpServer/startupStatus/updated', failed)).toEqual([{ type: 'notice', sessionId: S, level: 'warning', text: failed.error }])
    expect(n('mcpServer/startupStatus/updated', { ...failed, status: 'starting', error: null })).toEqual([])
    expect(n('mcpServer/startupStatus/updated', { ...failed, status: 'ready', error: null })).toEqual([])
    expect(n('mcpServer/startupStatus/updated', { ...failed, error: null, failureReason: 'reauthenticationRequired' })).toEqual([
      { type: 'notice', sessionId: S, level: 'warning', text: 'MCP server `cc304_broken` failed to start (it needs you to sign in again)' },
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
      { type: 'notice', sessionId: S, level: 'warning', text: "This thread's settings were changed outside Centralu: model gpt-5.6-luna → gpt-5.6" },
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
      { type: 'notice', sessionId: S, level: 'warning', text: "This thread's settings were changed outside Centralu: model gpt-5.6-luna → gpt-5.6" },
      { type: 'settings_changed', sessionId: S, model: 'gpt-5.6', effort: 'high', verbosity: null, serviceTier: null, by: 'tool' },
    ])
  })
})
