import { describe, expect, it } from 'vitest'
import { AgyAdapter, type AgyDeps } from './index.js'

const LOGGED_OUT = { stdout: '', stderr: "Error: authentication required. Run 'agy' to log in, then retry.\nerror: authentication failed or timed out\n" }
const LOGGED_IN = { stdout: '{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t50%\n"}\n', stderr: '' }

function adapter(over: Partial<AgyDeps> & { loggedIn?: boolean } = {}) {
  const calls: { args: string[]; detached: boolean }[] = []
  const deps: AgyDeps = {
    supported: () => true,
    find: () => ({ command: '/bin/agy', args: [] }),
    run: async (_c, args, detached) => {
      calls.push({ args, detached })
      return args.includes('--version') ? { stdout: '1.4.8\n', stderr: '' } : over.loggedIn === false ? LOGGED_OUT : LOGGED_IN
    },
    ...over,
  }
  return { a: new AgyAdapter(deps), calls }
}

describe('Antigravity detection', () => {
  it('reports the version and a login when agy answers a read-only command', async () => {
    const { a } = adapter()
    expect(await a.detect()).toEqual({ tool: 'agy', installed: true, loggedIn: true, detail: 'agy 1.4.8' })
  })

  it('records a logged-out agy as installed and not logged in', async () => {
    const { a } = adapter({ loggedIn: false })
    expect(await a.detect()).toEqual({ tool: 'agy', installed: true, loggedIn: false, detail: 'agy 1.4.8 · login required' })
  })

  it('asks with a command that runs no turn, in a session of its own so it has no terminal to log in on', async () => {
    const { a, calls } = adapter()
    await a.detect()
    const ask = calls.find((c) => c.args.includes('/usage'))
    expect(ask?.args).toEqual(['-p', '/usage', '--output-format', 'json'])
    expect(ask?.detached).toBe(true)
  })

  it('reuses one answer for a minute', async () => {
    const { a, calls } = adapter()
    await a.detect()
    await a.detect()
    expect(calls).toHaveLength(2)
  })

  it('shows not installed when agy is not on PATH', async () => {
    const { a, calls } = adapter({ find: () => null })
    const r = await a.detect()
    expect(r).toMatchObject({ installed: false, loggedIn: false })
    expect(calls).toHaveLength(0)
    expect(await a.installedVersion()).toBeNull()
  })

  it('shows not available on Windows without starting anything, even when agy is installed', async () => {
    const { a, calls } = adapter({ supported: () => false })
    expect(await a.detect()).toEqual({ tool: 'agy', installed: false, loggedIn: false, detail: 'Antigravity is not available on Windows yet' })
    expect(calls).toHaveLength(0)
  })

  it('offers no context share', () => {
    expect(adapter().a.capabilities.contextUsage).toBe('none')
  })
})
