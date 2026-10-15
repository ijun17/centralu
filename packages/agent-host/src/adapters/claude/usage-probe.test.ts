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
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of prompt) void _
    })()
    let asks = 0
    const q = {
      closed: false,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
      interrupt: async () => {},
      close: () => {
        q.closed = true
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        if (asks++ < fake.failFirst) throw new Error('still starting')
        return { subscription_type: 'max', rate_limits: { limits: [{ kind: 'weekly_all', percent: 61 }] } }
      },
    }
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
