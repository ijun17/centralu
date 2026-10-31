import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRpcHandler } from './rpc.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import type { AgentAdapter } from './adapters/contract.js'
import type { ToolName } from '@cc/protocol'
import { CRASH_LINES_PER_WINDOW, CRASH_WINDOW_MS, createUiCrashLog } from './ui-crash-log.js'

const crash = { message: 'Minified React error #185', stack: 'at a\nat b', componentStack: '\n    at PeekLine' }

describe('the line a window writes to the host log when its screen crashed', () => {
  it('is one line with a prefix, carries the three fields, and cuts each to its cap', () => {
    const lines: string[] = []
    createUiCrashLog((l) => lines.push(l))({ message: 'm'.repeat(5000), stack: 's'.repeat(9000), componentStack: crash.componentStack })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[ui-crash\] \{/)
    expect(lines[0]).not.toContain('\n')
    const body = JSON.parse(lines[0]!.slice('[ui-crash] '.length)) as Record<string, string>
    expect(body.message!.length).toBeLessThan(600)
    expect(body.stack!.length).toBeLessThan(3100)
    expect(body.componentStack).toBe(crash.componentStack)
  })

  it('writes a few lines a minute, counts the rest, and says how many it left out on the next line after the window', () => {
    const lines: string[] = []
    let t = 1_000
    const log = createUiCrashLog((l) => lines.push(l), () => t)
    for (let i = 0; i < CRASH_LINES_PER_WINDOW + 40; i++) log(crash)
    expect(lines).toHaveLength(CRASH_LINES_PER_WINDOW)
    t += CRASH_WINDOW_MS
    log(crash)
    expect(lines).toHaveLength(CRASH_LINES_PER_WINDOW + 1)
    expect(JSON.parse(lines.at(-1)!.slice('[ui-crash] '.length)).skipped).toBe(40)
  })

  describe('through the RPC door', () => {
    afterEach(() => vi.restoreAllMocks())

    it('ui.reportCrash logs the line on stderr and answers', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const adapters = new Map<ToolName, AgentAdapter>()
      const rpc = createRpcHandler(new SessionManager(new Store(), adapters, () => {}), adapters)
      expect(await rpc('ui.reportCrash', crash)).toEqual({})
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ui-crash] '))
      expect(line).toContain('PeekLine')
    })
  })
})
