import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../store/store.js'
import { dayBreaksOnPage, foldIsOpen, foldKeys, foldRuns, foldSummary, liveRun, liveStep, rowsBeyond } from './foldRuns.js'

let n = 0
// A row without its render key, whichever kind: the key is numbered here
type Draft = ChatItem extends infer T ? (T extends unknown ? Omit<T, 'seq'> & { seq?: number } : never) : never
const row = (item: Draft): ChatItem => ({ ...item, seq: item.seq ?? ++n })
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

  it('never folds an ask_project call until it is answered: its card says the session it asked waits on the person', () => {
    const asking = tool({ tool: 'mcp__centralu__ask_project', result: undefined, ok: undefined })
    expect(foldRuns([tool(), asking, tool()], none).runs).toHaveLength(2)
    const answered = tool({ tool: 'mcp__centralu__ask_project', result: 'done', ok: true })
    expect(foldRuns([tool(), answered, tool()], none).runs).toHaveLength(1)
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
  it('names a row by the host number when it has one (a re-read keeps the open state) and by its render key (a row stored while the run is open keeps it open)', () => {
    expect(foldKeys({ seq: 9, storedSeq: 4 })).toEqual(['s4', 'r9'])
    expect(foldKeys({ seq: 9 })).toEqual(['r9'])
    // A row read back has the host's number as its render key: no `r` name that a live row's key could be taken for
    expect(foldKeys({ seq: 4, storedSeq: 4 })).toEqual(['s4'])
  })

  it('is open when any row of it is, so a run that grows at either end stays open', () => {
    const [run] = foldRuns([tool({ storedSeq: 5 }), tool({ storedSeq: 6 })], none).runs
    expect(foldIsOpen(run!, undefined, null)).toBe(false)
    expect(foldIsOpen(run!, { s6: true }, null)).toBe(true)
    // Opened while its row had no host number yet: the number arriving later does not close it
    const [live] = foldRuns([tool({ seq: 70 })], none).runs
    const opened = Object.fromEntries(live!.keys.map((k) => [k, true as const]))
    const [stored] = foldRuns([tool({ seq: 70, storedSeq: 12 })], none).runs
    expect(foldIsOpen(stored!, opened, null)).toBe(true)
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

  it('moves a day divider off a row the fold hides onto the first row after the run', () => {
    const chat = [said(), tool(), tool(), said()]
    const { runs } = foldRuns(chat, none)
    const breaks = new Map([[2, 'Sunday']])
    expect([...dayBreaksOnPage(breaks, runs, chat.length, () => false)]).toEqual([[3, 'Sunday']])
    // Open, the divider stays on its own row
    expect([...dayBreaksOnPage(breaks, runs, chat.length, () => true)]).toEqual([[2, 'Sunday']])
  })

  it('leaves the next row its own divider, and lets a run that ends the conversation carry the day on its line', () => {
    const chat = [said(), tool(), tool(), said()]
    const { runs } = foldRuns(chat, none)
    expect([...dayBreaksOnPage(new Map([[2, 'Sunday'], [3, 'Monday']]), runs, chat.length, () => false)]).toEqual([[3, 'Monday']])
    const ending = [said(), tool(), tool()]
    expect([...dayBreaksOnPage(new Map([[2, 'Sunday']]), foldRuns(ending, none).runs, ending.length, () => false)]).toEqual([[1, 'Sunday']])
  })
})

describe('liveStep and liveRun', () => {
  it('is the last row of the run: the call by its words, Thinking for a thought', () => {
    const chat = [tool({ title: 'first' }), tool({ title: 'run2.sh before', result: undefined, ok: undefined })]
    expect(liveStep(chat, foldRuns(chat, none).runs[0]!)).toBe('Bash: run2.sh before')
    const ending = [tool(), thought()]
    expect(liveStep(ending, foldRuns(ending, none).runs[0]!)).toBe('Thinking')
  })

  it('does not stay on an earlier call still without an answer (a background agent) once the turn went on', () => {
    const chat = [tool({ tool: 'Agent', title: 'Research', result: undefined, ok: undefined }), tool({ title: 'git status' })]
    expect(liveStep(chat, foldRuns(chat, none).runs[0]!)).toBe('Bash: git status')
  })

  it('names a Centralu call by its own label, and keeps one line of a command that runs over several', () => {
    const call = tool({ title: 'write the parser', centralu: { tool: 'start_agent', label: 'Started an agent' }, result: undefined, ok: undefined })
    expect(liveStep([call], foldRuns([call], none).runs[0]!)).toBe('Started an agent: write the parser')
    const chat = [tool({ title: 'cd app\nnpm test', result: undefined, ok: undefined })]
    expect(liveStep(chat, foldRuns(chat, none).runs[0]!)).toBe('Bash: cd app …')
  })

  it('is live only while working, for the last run, and through decided approvals after it', () => {
    const chat = [tool(), row({ kind: 'approval', requestId: 'r', summary: 'x', decision: 'allow' })]
    const { runs } = foldRuns(chat, none)
    expect(liveRun(chat, runs, true)).toBe(runs[0])
    expect(liveRun(chat, runs, false)).toBeNull()
    const answered = [tool(), said()]
    expect(liveRun(answered, foldRuns(answered, none).runs, true)).toBeNull()
  })
})

describe('rowsBeyond', () => {
  it('counts the rows between a row and the drawn range, and none inside it', () => {
    const range = { startIndex: 20, endIndex: 30 }
    const none = new Uint8Array(60)
    expect(rowsBeyond(range, 25, none)).toBe(0)
    expect(rowsBeyond(range, 5, none)).toBe(15)
    expect(rowsBeyond(range, 45, none)).toBe(15)
  })

  it('does not count the rows a closed run hides, which stand at no height', () => {
    const range = { startIndex: 20, endIndex: 30 }
    const hidden = new Uint8Array(60)
    hidden.fill(1, 6, 20)
    // Rows 6-19 are hidden: only row 5 is drawn between row 5 and the range
    expect(rowsBeyond(range, 5, hidden)).toBe(1)
    hidden.fill(1, 31, 60)
    expect(rowsBeyond(range, 45, hidden)).toBe(0)
  })

  it('stops counting at the limit', () => {
    expect(rowsBeyond({ startIndex: 500, endIndex: 510 }, 0, new Uint8Array(600), 12)).toBe(13)
  })
})
