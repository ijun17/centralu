import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * Usage with no session running (#726). The SDK puts the usage call only on a Query, so a host nobody had a session on
 * (a linked machine, mostly) answered "A running session is required to read usage". The adapter now starts a probe
 * session for the read and stops it right after. The SDK and the CLI's `auth status` are fakes here, so what is checked
 * is only what the adapter does around them.
 */
const fake = vi.hoisted(() => ({
  /** `claude auth status --json` output */
  status: '{}',
  /** The queries the SDK was asked to start, with whether each was closed */
  queries: [] as { closed: boolean }[],
  /** How many asks of usage fail before one answers (the CLI is still starting) */
  failFirst: 0,
  /** What the SDK was started with, per query */
  options: [] as Record<string, unknown>[],
  /** Replaces the usage call: an SDK without it (`null`) */
  noUsageCall: false,
  /** The CLI leaves this long after it is closed, as on Windows where it keeps its folder until then */
  exitDelayMs: 0,
  /** Whether the probe's folder was still there when the process left */
  folderAtExit: null as boolean | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    fake.options.push(options)
    void (async () => {
      for await (const _ of prompt) void _
    })()
    let asks = 0
    let endStream = () => {}
    const q = {
      closed: false,
      // Quiet until closed, then ended, as the CLI's stream is once its process has left
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((r) => (endStream = () => r({ value: undefined, done: true }))) }),
      interrupt: async () => {},
      close: () => {
        q.closed = true
        setTimeout(() => {
          fake.folderAtExit = existsSync(String(options.cwd))
          endStream()
        }, fake.exitDelayMs)
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        if (asks++ < fake.failFirst) throw new Error('still starting')
        return { subscription_type: 'max', rate_limits: { limits: [{ kind: 'weekly_all', percent: 61 }] } }
      },
    }
    if (fake.noUsageCall) delete (q as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    fake.queries.push(q)
    return q
  },
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = () => Promise.resolve({ stdout: fake.status, stderr: '' })
  return { execFile: Object.assign(execFile, { [promisify.custom]: execFile }) }
})
vi.mock('../../env-path.js', () => ({ whichTool: () => '/usr/local/bin/claude' }))

const { ClaudeAdapter } = await import('./index.js')

/** An adapter whose probe gives up fast, so a failure does not take the 12 s it is allowed in the app */
const quick = () => new ClaudeAdapter({ probeAskMs: 60, probeRetryMs: 10 })

const LOGGED_IN = JSON.stringify({ loggedIn: true, orgId: 'org-1', email: 'person@example.com', subscriptionType: 'max' })

describe('claude usage with no session running (#726)', () => {
  it('starts a probe session for the read and stops it right after', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.failFirst = 0
    const adapter = new ClaudeAdapter()
    const usage = await adapter.listUsage()
    expect(usage.windows).toMatchObject([{ id: 'weekly_all', percent: 61 }])
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0]!.closed).toBe(true)
    expect([...ClaudeAdapter.liveQueries]).toEqual([])
  })

  it('asks again while the CLI behind the probe is still starting', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.failFirst = 2
    const usage = await new ClaudeAdapter().listUsage()
    expect(usage.windows[0]?.percent).toBe(61)
    expect(fake.queries).toHaveLength(1)
  })

  it('shares one probe between two askers at once', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.failFirst = 0
    const adapter = new ClaudeAdapter()
    await Promise.all([adapter.listUsage(), adapter.listUsage()])
    expect(fake.queries).toHaveLength(1)
  })

  it('does not start a probe when Claude Code is not logged in, and says so', async () => {
    fake.status = JSON.stringify({ loggedIn: false })
    fake.queries.length = 0
    await expect(new ClaudeAdapter().listUsage()).rejects.toThrow('not logged in')
    expect(fake.queries).toHaveLength(0)
  })

  it('starts the probe as a bare session: no settings files, no code intelligence, no MCP servers of the person, safe', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.options.length = 0
    fake.failFirst = 0
    await new ClaudeAdapter().listUsage()
    const o = fake.options[0]!
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.permissionMode).toBe('default')
    expect(o.mcpServers).toBeUndefined()
    expect(JSON.stringify(o.settings)).toContain('typescript-lsp')
    // The folder is a temporary one of its own
    expect(String(o.cwd)).toContain('centralu-usage-probe-')
  })

  it('does not lend its query to a model list asked meanwhile, and a session of the person is started without the strict flag', async () => {
    fake.status = LOGGED_IN
    fake.failFirst = 0
    fake.options.length = 0
    const adapter = new ClaudeAdapter()
    const seen: unknown[] = []
    const reading = adapter.listUsage()
    // The probe's query is up as soon as it is created, and nobody else may borrow it
    await vi.waitFor(() => expect(fake.options.length).toBe(1))
    seen.push(ClaudeAdapter.lastQuery)
    await reading
    expect(seen).toEqual([null])
    const session = await adapter.createSession({ sessionId: 's726b', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    try {
      expect(fake.options.at(-1)!.strictMcpConfig).toBeUndefined()
    } finally {
      await session.dispose()
    }
  })

  it('removes the probe\'s folder only after its process has left, which on Windows holds the folder until then', async () => {
    fake.status = LOGGED_IN
    fake.failFirst = 0
    fake.exitDelayMs = 150
    fake.folderAtExit = null
    try {
      await new ClaudeAdapter().listUsage()
      expect(fake.folderAtExit).toBe(true)
      expect(existsSync(String(fake.options.at(-1)!.cwd))).toBe(false)
    } finally {
      fake.exitDelayMs = 0
    }
  })

  it('stops the probe and removes its folder when the read fails, and does not start another for five minutes', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.options.length = 0
    fake.failFirst = 1_000
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const adapter = quick()
      await expect(adapter.listUsage()).rejects.toThrow('still starting')
      expect(fake.queries).toHaveLength(1)
      expect(fake.queries[0]!.closed).toBe(true)
      expect(existsSync(String(fake.options[0]!.cwd))).toBe(false)
      expect(log.mock.calls.flat().join('\n')).toContain('a probe session could not read usage: still starting')
      // The failure stands: a meter that asks again does not start another process
      await expect(adapter.listUsage()).rejects.toThrow('still starting')
      expect(fake.queries).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  it('keeps an answer for five minutes, so the meter\'s polls start one process each, not one per minute', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.failFirst = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const adapter = new ClaudeAdapter()
      await adapter.listUsage()
      vi.setSystemTime(Date.now() + 4 * 60_000)
      await adapter.listUsage()
      expect(fake.queries).toHaveLength(1)
      vi.setSystemTime(Date.now() + 2 * 60_000)
      await adapter.listUsage()
      expect(fake.queries).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not ask on for twelve seconds of an SDK that has no usage call', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.noUsageCall = true
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const started = Date.now()
      await expect(new ClaudeAdapter().listUsage()).rejects.toThrow('does not support usage queries')
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      fake.noUsageCall = false
      log.mockRestore()
    }
  })

  it('sweeps the folders earlier probes left, and only the old ones with its own prefix', async () => {
    fake.status = LOGGED_IN
    fake.failFirst = 0
    const old = join(tmpdir(), 'centralu-usage-probe-old726')
    const fresh = join(tmpdir(), 'centralu-usage-probe-fresh726')
    const other = join(tmpdir(), 'cc-usage-old726')
    for (const d of [old, fresh, other]) mkdirSync(d, { recursive: true })
    const past = new Date(Date.now() - 3600_000)
    for (const d of [old, other]) utimesSync(d, past, past)
    try {
      await new ClaudeAdapter().listUsage()
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(other)).toBe(true)
    } finally {
      for (const d of [old, fresh, other]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('reads from a running session as before, without a probe', async () => {
    fake.status = LOGGED_IN
    fake.queries.length = 0
    fake.failFirst = 0
    const adapter = new ClaudeAdapter()
    const session = await adapter.createSession({ sessionId: 's726', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    try {
      await adapter.listUsage()
      expect(fake.queries).toHaveLength(1)
    } finally {
      await session.dispose()
    }
  })
})

describe('the account claude reports (#726)', () => {
  it('fingerprints the account without letting the email or the organisation out', async () => {
    fake.status = LOGGED_IN
    const a = await new ClaudeAdapter().account()
    expect(a.loggedIn).toBe(true)
    expect(a.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(a)).not.toContain('example.com')
    expect(JSON.stringify(a)).not.toContain('org-1')
    // The same account on another machine, however the email is cased, is the same
    fake.status = JSON.stringify({ loggedIn: true, orgId: 'org-1', email: 'Person@Example.com' })
    expect((await new ClaudeAdapter().account()).fingerprint).toBe(a.fingerprint)
  })

  it('tells another account, another organisation and a login with no account apart', async () => {
    const fp = async (status: object) => {
      fake.status = JSON.stringify(status)
      return (await new ClaudeAdapter().account()).fingerprint
    }
    const base = await fp({ loggedIn: true, orgId: 'org-1', email: 'a@x.com' })
    expect(await fp({ loggedIn: true, orgId: 'org-1', email: 'b@x.com' })).not.toBe(base)
    expect(await fp({ loggedIn: true, orgId: 'org-2', email: 'a@x.com' })).not.toBe(base)
    expect(await fp({ loggedIn: true, authMethod: 'apiKey' })).toBeNull()
    expect(await fp({ loggedIn: false })).toBeNull()
  })

  it('answers unknown, not logged out, from a CLI that prints no JSON', async () => {
    fake.status = 'error: unknown command auth'
    expect(await new ClaudeAdapter().account()).toEqual({ loggedIn: null, fingerprint: null })
  })
})
