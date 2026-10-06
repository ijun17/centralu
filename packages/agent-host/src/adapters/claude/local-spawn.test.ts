import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { AgentProcess } from '../contract.js'
import { fakeAgentCli, goneWithin, helperPid, killLeftovers } from '../fake-agent-cli.test-helpers.js'

/**
 * Claude without a keeper (Windows, dev, e2e, a debug app). The SDK's own spawn signals only the
 * CLI's pid, so a CLI that ended left its helpers (a language server and its `tsserver`, MCP
 * servers) running. The adapter spawns the CLI itself instead (`local-process.ts`). The SDK is
 * swapped for a fake that records its options and can fail the way the real one does when the CLI
 * exits with an error; the CLI is a real process.
 */
const sdk = vi.hoisted(() => {
  const state = { options: null as null | Record<string, unknown>, fail: null as null | ((e: Error) => void) }
  return { state }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    sdk.state.options = args.options
    let fail: (e: Error) => void = () => {}
    const failed = new Promise<never>((_, reject) => (fail = reject))
    sdk.state.fail = fail
    return {
      // A stream that ends the way the SDK's does when the CLI exits with an error: it throws
      [Symbol.asyncIterator]: () => ({ next: () => failed }),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

const unix = process.platform !== 'win32'
// Real processes: a node start costs seconds on a loaded machine
vi.setConfig({ testTimeout: 30_000 })
const started: number[] = []
afterEach(() => killLeftovers(started))

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter({ platform: process.platform, executable: () => null, startGapMs: 0 }).createSession(
    { sessionId: 's1', cwd: process.cwd(), permissionPreset: 'normal' },
    (e) => events.push(e),
  )
  await new Promise((r) => setTimeout(r, 20))
  const spawn = sdk.state.options?.spawnClaudeCodeProcess as ((o: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }) => AgentProcess) | undefined
  return { handle, events, spawn }
}

describe.skipIf(!unix)('a Claude session without a keeper', () => {
  it('spawns the CLI itself, and stopping it ends the helper the CLI leaves behind', async () => {
    const { handle, spawn } = await session()
    expect(spawn).toBeTypeOf('function')
    const p = spawn!({ ...fakeAgentCli(), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper)
    const exited = new Promise((r) => p.once('exit', r))
    // What the SDK's close does once its grace is over
    p.kill('SIGTERM')
    await exited
    expect(await goneWithin(helper, 5000)).toBe(true)
    await handle.dispose()
  })

  it('a failure still carries the end of what the CLI wrote to stderr', async () => {
    const { handle, events, spawn } = await session()
    const p = spawn!({ command: process.execPath, args: ['-e', 'console.error("Invalid API key"); process.exit(1)'], env: process.env })
    await new Promise((r) => p.once('exit', r))
    sdk.state.fail!(new Error('Claude Code process exited with code 1'))
    await new Promise((r) => setTimeout(r, 20))
    const crash = events.find((e) => e.type === 'error') as Extract<NormalizedEvent, { type: 'error' }> | undefined
    expect(crash?.error.message).toBe('Claude Code process exited with code 1. stderr: Invalid API key')
    await handle.dispose()
  })
})
