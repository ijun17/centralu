import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../store/store.js'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'

const user = (seq: number, text: string): ChatItem => ({ kind: 'user', seq, text })
const bot = (seq: number, text: string): ChatItem => ({ kind: 'assistant', seq, text })

describe('collecting sent messages', () => {
  it('only my own messages, oldest first', () => {
    expect(sentMessages([user(1, '하나'), bot(2, '답'), user(3, '둘')])).toEqual(['하나', '둘'])
  })

  it('the same message back to back counts once — pressing the arrow key twice to move past it would look unpressed', () => {
    expect(sentMessages([user(1, '다시'), user(2, '다시'), user(3, '그만')])).toEqual(['다시', '그만'])
  })

  it('the same message counts again if another message comes between — that time it really was sent twice', () => {
    expect(sentMessages([user(1, 'a'), user(2, 'b'), user(3, 'a')])).toEqual(['a', 'b', 'a'])
  })

  it('tool and approval entries are not something I said', () => {
    const chat: ChatItem[] = [
      { kind: 'tool', seq: 1, tool: 'Bash', title: 'ls', readOnly: true },
      { kind: 'mark', seq: 2, text: '압축됨' },
      user(3, '진짜 내 말'),
    ]
    expect(sentMessages(chat)).toEqual(['진짜 내 말'])
  })
})

describe('which line the caret is on', () => {
  it('a single line is both the first line and the last — so both up and down go to history', () => {
    expect(onFirstLine('한 줄', 2)).toBe(true)
    expect(onLastLine('한 줄', 2)).toBe(true)
  })

  it('with multiple lines, only the top line goes up', () => {
    const text = '첫 줄\n둘째 줄'
    expect(onFirstLine(text, 1)).toBe(true)
    expect(onFirstLine(text, 7)).toBe(false)
    expect(onLastLine(text, 1)).toBe(false)
    expect(onLastLine(text, 7)).toBe(true)
  })

  it('the boundary right before and after a newline', () => {
    const text = 'a\nb'
    // Before the newline = still the first line
    expect(onFirstLine(text, 1)).toBe(true)
    expect(onLastLine(text, 1)).toBe(false)
    // After the newline = already the last line
    expect(onFirstLine(text, 2)).toBe(false)
    expect(onLastLine(text, 2)).toBe(true)
  })

  it('an empty composer is true on both sides', () => {
    expect(onFirstLine('', 0)).toBe(true)
    expect(onLastLine('', 0)).toBe(true)
  })
})

describe('one arrow-key press', () => {
  const history = ['가장 오래된', '가운데', '가장 최근']

  it('pressing up for the first time recalls the most recently sent message', () => {
    expect(stepHistory({ history, at: null, dir: -1 })).toEqual({ kind: 'recall', at: 2, text: '가장 최근' })
  })

  it('pressing up again keeps going further back', () => {
    expect(stepHistory({ history, at: 2, dir: -1 })).toEqual({ kind: 'recall', at: 1, text: '가운데' })
  })

  /* Letting the caret move instead would make "history has ended" read as "the arrow key stopped working" */
  it('going further up than the oldest entry stays put', () => {
    expect(stepHistory({ history, at: 0, dir: -1 })).toEqual({ kind: 'recall', at: 0, text: '가장 오래된' })
  })

  it('pressing down moves to a more recent entry', () => {
    expect(stepHistory({ history, at: 0, dir: 1 })).toEqual({ kind: 'recall', at: 1, text: '가운데' })
  })

  /* Losing an in-progress draft to one stray keypress is exactly the kind of loss this app has kept fixing */
  it('pressing down once more from the most recent entry returns to the unsent draft', () => {
    expect(stepHistory({ history, at: 2, dir: 1 })).toEqual({ kind: 'draft' })
  })

  it('the down arrow is just the caret while not browsing history', () => {
    expect(stepHistory({ history, at: null, dir: 1 })).toEqual({ kind: 'none' })
  })

  it('with no sent messages, the arrow key is just an arrow key', () => {
    expect(stepHistory({ history: [], at: null, dir: -1 })).toEqual({ kind: 'none' })
  })
})
