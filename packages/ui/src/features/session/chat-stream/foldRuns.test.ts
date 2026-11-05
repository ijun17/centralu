import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../store/store.js'
import { dayBreaksOnPage, foldIsOpen, foldKey, foldRuns, foldSummary, liveStep } from './foldRuns.js'

let n = 0
const row = <T extends ChatItem>(item: Omit<T, 'seq'> & { seq?: number }): ChatItem => ({ ...item, seq: item.seq ?? ++n }) as ChatItem
const user = () => row({ kind: 'user', text: 'q' })
const said = () => row({ kind: 'assistant', text: 'a' })
const thought = (over: Partial<Extract<ChatItem, { kind: 'reasoning' }>> = {}) => row({ kind: 'reasoning', text: 't', ...over })
const tool = (over: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}) =>
  row({ kind: 'tool', tool: 'Bash', title: 'ls', callId: `c${++n}`, result: 'ok', ok: true, ...over })
const none = () => false

describe('foldRuns: which rows fold', () => {
  it('makes one run of the reasoning and tool rows between two bubbles', () => {
    const chat = [user(), said(), thought(), tool(), tool(), said()]
    const { runs, runOf } = foldRuns(chat, none)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ first: 2, last: 4, thoughts: 1, tools: 2, failed: 0 })
    expect([...runOf]).toEqual([-1, -1, 2, 2, 2, -1])
  })

  it('folds a run that ends the conversation, and one between a message and a bubble', () => {
    const { runs } = foldRuns([user(), tool(), said(), tool()], none)
    expect(runs.map((r) => [r.first, r.last])).toEqual([[1, 1], [3, 3]])
  })

  it('never folds a decided approval, and a row of them splits the run', () => {
    const chat = [tool(), row({ kind: 'approval', requestId: 'r', summary: 'x', decision: 'allow' }), tool()]
    expect(foldRuns(chat, none).runs.map((r) => [r.first, r.last])).toEqual([[0, 0], [2, 2]])
  })

  it('never folds a marker: an error line, a usage limit, a stop cut, compaction, a handoff', () => {
    const chat = [tool(), row({ kind: 'mark', text: 'The turn failed' }), thought(), row({ kind: 'mark', text: 'compacted' }), tool()]
    expect(foldRuns(chat, none).runs.map((r) => [r.first, r.last])).toEqual([[0, 0], [2, 2], [4, 4]])
  })

  it('never folds an image the agent shows', () => {
    const chat = [thought(), row({ kind: 'image', mime: 'image/png', data: 'AAAA' }), thought()]
    expect(foldRuns(chat, none).runs).toHaveLength(2)
  })

  it('never folds the call that opened an app view in the conversation', () => {
    const chat = [tool({ callId: 'a' }), tool({ callId: 'view' }), tool({ callId: 'b' })]
    const { runs, runOf } = foldRuns(chat, (id) => id === 'view')
    expect(runs.map((r) => [r.first, r.last])).toEqual([[0, 0], [2, 2]])
    expect(runOf[1]).toBe(-1)
  })

  it("never folds a manager's worktree proposal, which waits on the person to take it", () => {
    const chat = [tool(), tool({ tool: 'mcp__centralu__propose_worktree_session' }), tool()]
    expect(foldRuns(chat, none).runs).toHaveLength(2)
  })

  it('counts the failed calls, and the time from the run first row to its last', () => {
    const chat = [thought({ at: 1_000 }), tool({ ok: false, at: 61_000 }), tool({ ok: false, result: 'x', at: 121_000 }), tool({ at: 241_000 })]
    expect(foldRuns(chat, none).runs[0]).toMatchObject({ failed: 2, seconds: 240 })
  })
})

describe('foldRuns: how a run is remembered and drawn', () => {
  it('names a row by the host number when it has one, so a re-read keeps the open state', () => {
    expect(foldKey({ seq: 9, storedSeq: 4 })).toBe('s4')
    expect(foldKey({ seq: 9 })).toBe('r9')
  })

  it('is open when any row of it is, so a run that grows at either end stays open', () => {
    const [run] = foldRuns([tool({ storedSeq: 5 }), tool({ storedSeq: 6 })], none).runs
    expect(foldIsOpen(run!, undefined, null)).toBe(false)
    expect(foldIsOpen(run!, { s6: true }, null)).toBe(true)
    expect(foldIsOpen(run!, { s9: true }, null)).toBe(false)
  })

  it('is open while a search hit is inside it', () => {
    const [run] = foldRuns([user(), tool(), tool(), said()], none).runs
    expect(foldIsOpen(run!, undefined, 2)).toBe(true)
    expect(foldIsOpen(run!, undefined, 3)).toBe(false)
  })

  it('says what a run holds and, from five seconds, how long it took', () => {
    const run = (chat: ChatItem[]) => foldRuns(chat, none).runs[0]!
    expect(foldSummary(run([thought(), tool(), tool()]))).toBe('1 thought · 2 tools')
    expect(foldSummary(run([thought(), thought(), tool()]))).toBe('2 thoughts · 1 tool')
    expect(foldSummary(run([tool({ at: 0 }), tool({ at: 4_000 })]))).toBe('2 tools')
    expect(foldSummary(run([tool({ at: 0 }), tool({ at: 252_000 })]))).toBe('2 tools · 4m 10s')
  })

  it('moves a day divider off a row the fold hides onto its line', () => {
    const chat = [said(), tool(), tool(), said()]
    const { runs, runOf } = foldRuns(chat, none)
    const breaks = new Map([[2, 'Sunday']])
    expect([...dayBreaksOnPage(breaks, runs, runOf, () => false)]).toEqual([[1, 'Sunday']])
    // Open, the divider stays on its own row
    expect([...dayBreaksOnPage(breaks, runs, runOf, () => true)]).toEqual([[2, 'Sunday']])
  })
})

describe('liveStep', () => {
  it('is the tool call still without an answer', () => {
    const chat = [tool({ title: 'first' }), tool({ title: 'run2.sh before', result: undefined, ok: undefined })]
    const [run] = foldRuns(chat, none).runs
    expect(liveStep(chat, run!)).toBe('Bash: run2.sh before')
  })

  it('is the last call when all are answered, and Thinking when the run ends on a thought', () => {
    const chat = [tool({ title: 'first' }), tool({ title: 'second' })]
    expect(liveStep(chat, foldRuns(chat, none).runs[0]!)).toBe('Bash: second')
    const ending = [tool(), thought()]
    expect(liveStep(ending, foldRuns(ending, none).runs[0]!)).toBe('Thinking')
  })

  it('keeps one line of a command that runs over several', () => {
    const chat = [tool({ title: 'cd app\nnpm test', result: undefined, ok: undefined })]
    expect(liveStep(chat, foldRuns(chat, none).runs[0]!)).toBe('Bash: cd app …')
  })
})
