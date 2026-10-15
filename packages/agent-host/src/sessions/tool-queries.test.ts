import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { ToolQueries, type ToolQueriesHost } from './tool-queries.js'

/*
 * A tool's model list as the host asks for it (#561, #660), on its own (#428): one read at a time, kept five minutes,
 * the last list kept when a read fails, and no new read for a minute after a failure. The manager's tests (models,
 * start_agent's model check, usage) run the same calls through the RPC.
 */

let reads: number
let answer: () => Promise<ModelOption[]>
let queries: ToolQueries

const m = (id: string) => ({ id, label: id }) as ModelOption

beforeEach(() => {
  vi.useFakeTimers()
  reads = 0
  answer = async () => [m('a')]
  const adapter = {
    listModels: () => {
      reads++
      return answer()
    },
  } as unknown as AgentAdapter
  queries = new ToolQueries({ adapters: new Map([['claude', adapter]]) } as unknown as ToolQueriesHost)
})
afterEach(() => vi.useRealTimers())

describe("a tool's models", () => {
  it('one read for calls at once, kept five minutes, read again after', async () => {
    const [x, y] = await Promise.all([queries.listModels('claude'), queries.listModels('claude')])
    expect(x).toEqual({ supported: true, models: [m('a')] })
    expect(y).toEqual(x)
    expect(reads).toBe(1)
    await queries.listModels('claude')
    expect(reads).toBe(1)
    vi.advanceTimersByTime(5 * 60_000)
    await queries.listModels('claude')
    expect(reads).toBe(2)
  })

  it('a failed read keeps the last list, and is not tried again within a minute by a caller that cannot wait', async () => {
    await queries.listModels('claude')
    vi.advanceTimersByTime(5 * 60_000)
    answer = async () => {
      throw new Error('the tool did not answer')
    }
    expect(await queries.listModels('claude')).toEqual({ supported: false, reason: 'the tool did not answer', models: [m('a')] })
    expect(reads).toBe(2)
    expect(await queries.modelsWithin('claude', 1_000)).toEqual({ models: [m('a')], cached: true })
    expect(reads).toBe(2)
    vi.advanceTimersByTime(60_000)
    answer = async () => [m('b')]
    expect(await queries.modelsWithin('claude', 1_000, true)).toEqual({ models: [m('b')], cached: false })
    expect(reads).toBe(3)
  })

  it('a tool that cannot list says so', async () => {
    const none = new ToolQueries({ adapters: new Map([['codex', {} as AgentAdapter]]) } as unknown as ToolQueriesHost)
    expect(await none.listModels('codex')).toEqual({ supported: false, reason: 'codex does not support listing models', models: [] })
    expect(await none.modelsWithin('codex', 1_000)).toBeNull()
  })
})
