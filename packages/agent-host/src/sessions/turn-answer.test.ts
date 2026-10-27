import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { lastResponse, lastResponseSeq, turnAnswer } from './turn-answer.js'

const row = (seq: number, role: StoredMessage['role'], kind: StoredMessage['kind'], text = '', extra: object = {}): StoredMessage =>
  ({ sessionId: 's', seq, role, kind, payload: { text, ...extra }, ts: seq })
const said = (seq: number, text: string) => row(seq, 'assistant', 'text', text)
/** A message a session sent in (a caller's note): its row says who */
const asked = (seq: number, text: string) => row(seq, 'user', 'text', text, { from: { sessionId: 'caller', name: 'Parent' } })
/** A message the person typed: it says nobody sent it */
const typed = (seq: number, text: string) => row(seq, 'user', 'text', text)
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
    expect(lastResponse(followUp, { after: 3 })).toBe('second answer')
    expect(lastResponseSeq(followUp, { after: 3 })).toBe(4)
    expect(turnAnswer(followUp, { afterSeq: 3 })).toBe('second answer')
  })

  it("is whole when a note splits the turn's text: the part before the note and the part after it", () => {
    const split = [asked(1, 'task'), said(2, 'the first half'), asked(3, 'a note'), said(4, 'the second half')]
    expect(lastResponse(split, { after: 1 })).toBe('the first half\n\nthe second half')
    expect(lastResponseSeq(split, { after: 1 })).toBe(2)
  })

  it('stops at a tool call all the same: text before one is a plan, not the answer', () => {
    const rows = [asked(1, 'task'), said(2, 'a plan'), tool(3), said(4, 'the answer'), asked(5, 'a note'), said(6, 'and more')]
    expect(lastResponse(rows, { after: 1 })).toBe('the answer\n\nand more')
  })

  it('is empty for a turn that has said nothing yet, where the last response would be the turn before', () => {
    const begun = [asked(1, 'task'), said(2, 'first answer'), asked(3, 'a note'), tool(4)]
    expect(lastResponse(begun)).toBe('first answer')
    expect(lastResponse(begun, { after: 3 })).toBe('')
    expect(lastResponseSeq(begun, { after: 3 })).toBeNull()
  })

  it('reads the response past a tool call still running, as the last response does', () => {
    const rows = [asked(1, 'task'), said(2, 'about to look'), asked(3, 'a note'), said(4, 'and more'), tool(5)]
    expect(lastResponse(rows, { after: 1 })).toBe('about to look\n\nand more')
  })

  it("stops at a person's message in the turn: what the agent said before it is not the answer to what came after", () => {
    const rows = [asked(1, 'task'), said(2, 'part one'), typed(3, 'wait, one more thing'), said(4, 'part two')]
    // A control: the same rows with a caller's note in the place read whole
    expect(lastResponse([rows[0]!, rows[1]!, asked(3, 'a note'), rows[3]!], { after: 1 })).toBe('part one\n\npart two')
    expect(lastResponse(rows, { after: 1 })).toBe('part two')
    expect(lastResponseSeq(rows, { after: 1 })).toBe(4)
  })

  it('reads a turn up to where the next began: the turn that has begun since says nothing of this one', () => {
    const rows = [asked(1, 'task'), said(2, 'first answer'), asked(3, 'a note'), said(4, 'second answer')]
    expect(lastResponse(rows, { after: 1 })).toBe('first answer\n\nsecond answer')
    expect(lastResponse(rows, { after: 1, through: 3 })).toBe('first answer')
    expect(lastResponseSeq(rows, { after: 1, through: 3 })).toBe(2)
  })
})
