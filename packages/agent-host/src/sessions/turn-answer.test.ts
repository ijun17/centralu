import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { lastResponse, lastResponseSeq, turnAnswer } from './turn-answer.js'

const row = (seq: number, role: StoredMessage['role'], kind: StoredMessage['kind'], text = ''): StoredMessage =>
  ({ sessionId: 's', seq, role, kind, payload: { text }, ts: seq })
const said = (seq: number, text: string) => row(seq, 'assistant', 'text', text)
const asked = (seq: number, text: string) => row(seq, 'user', 'text', text)
const tool = (seq: number) => row(seq, 'assistant', 'tool_call')

/*
 * A caller's note that went into turn 1 and ran as turn 2 (#1604): its row is stored while turn 1 runs, before the rest of
 * that turn's words, so the rows are
 *   1 task, 2 note, 3 turn 1 says, 4 turn 2 says
 * and the record has no row of anyone's between the two turns' words.
 */
describe("a turn's response, read from where the turn began (#1604)", () => {
  const followUp = [asked(1, 'task'), asked(2, 'a note'), said(3, 'first answer'), said(4, 'second answer')]

  it("is the turn's own words alone from the row it began after: the turn before is not in it, as the report of the follow-up turn read it", () => {
    // Without a start both turns' words are joined: nothing of anyone's stands between them
    expect(lastResponse(followUp)).toBe('first answer\n\nsecond answer')
    expect(lastResponse(followUp, 3)).toBe('second answer')
    expect(lastResponseSeq(followUp, 3)).toBe(4)
    expect(turnAnswer(followUp, { afterSeq: 3 })).toBe('second answer')
  })

  it("is whole when a note splits the turn's text: the part before the note and the part after it", () => {
    const split = [asked(1, 'task'), said(2, 'the first half'), asked(3, 'a note'), said(4, 'the second half')]
    expect(lastResponse(split, 1)).toBe('the first half\n\nthe second half')
    expect(lastResponseSeq(split, 1)).toBe(2)
  })

  it('stops at a tool call all the same: text before one is a plan, not the answer', () => {
    const rows = [asked(1, 'task'), said(2, 'a plan'), tool(3), said(4, 'the answer'), asked(5, 'a note'), said(6, 'and more')]
    expect(lastResponse(rows, 1)).toBe('the answer\n\nand more')
  })

  it('is empty for a turn that has said nothing yet, where the last response would be the turn before', () => {
    const begun = [asked(1, 'task'), said(2, 'first answer'), asked(3, 'a note'), tool(4)]
    expect(lastResponse(begun)).toBe('first answer')
    expect(lastResponse(begun, 3)).toBe('')
    expect(lastResponseSeq(begun, 3)).toBeNull()
  })

  it('reads the response past a tool call still running, as the last response does', () => {
    const rows = [asked(1, 'task'), said(2, 'about to look'), asked(3, 'a note'), said(4, 'and more'), tool(5)]
    expect(lastResponse(rows, 1)).toBe('about to look\n\nand more')
  })
})
