import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@cc/protocol'
import { mergeBySeq, mergePage, prependPage, readBack, trimWindow } from './historyPages.js'
import { bumpChatKeysAbove, messagesToChat, nextChatKey, type ChatItem } from './transcript.js'

describe('mergeBySeq', () => {
  it('puts the rows of several reads in order', () => {
    expect(mergeBySeq([{ seq: 3 }, { seq: 1 }], [{ seq: 2 }]).map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('keeps one row per seq, the later list winning', () => {
    const before = [{ seq: 1, text: 'old' }, { seq: 2, text: 'old' }]
    const after = [{ seq: 2, text: 'new' }, { seq: 3, text: 'new' }]
    expect(mergeBySeq(before, after)).toEqual([
      { seq: 1, text: 'old' },
      { seq: 2, text: 'new' },
      { seq: 3, text: 'new' },
    ])
  })

  it('is empty for nothing', () => {
    expect(mergeBySeq()).toEqual([])
    expect(mergeBySeq([], [])).toEqual([])
  })
})

/*
 * The page side is built the way the store builds it: stored rows through `messagesToChat`, with the
 * key counter raised above them first (`loadHistory`). The screen side is the rows live events drew,
 * written out by hand with render keys far from the stored numbers, unless a test is about a clash.
 */
const said = (seq: number, text: string): StoredMessage =>
  ({ sessionId: 's', seq, role: 'user', kind: 'text', payload: { text }, ts: seq })
const answered = (seq: number, text: string): StoredMessage =>
  ({ sessionId: 's', seq, role: 'assistant', kind: 'text', payload: { text }, ts: seq })

function read(rows: StoredMessage[]): ChatItem[] {
  const items = messagesToChat(rows)
  bumpChatKeysAbove(items)
  return items
}

/** A row on screen, as a live event drew it: a fresh render key, and a stored number once the host gave one */
type Unkeyed = { [K in ChatItem['kind']]: Omit<Extract<ChatItem, { kind: K }>, 'seq'> }[ChatItem['kind']]
function live(row: Unkeyed): ChatItem {
  return { seq: nextChatKey() + 10_000, ...row } as ChatItem
}

const text = (it: ChatItem) => (it.kind === 'approval' ? `approval:${it.summary}` : 'text' in it ? it.text : it.kind)
const keysUnique = (items: ChatItem[]) => new Set(items.map((i) => i.seq)).size === items.length

describe('mergePage: the newest page against the rows already on screen', () => {
  it('an empty page leaves the screen as it is', () => {
    const have = [live({ kind: 'assistant', storedSeq: 4, text: 'kept' })]
    expect(mergePage(have, [], [])).toBe(have)
  })

  it('a screen row with a number on the page becomes one row, keeping the screen key', () => {
    const rows = [said(1, 'q'), answered(2, 'the full answer')]
    const onScreen = live({ kind: 'assistant', storedSeq: 2, text: 'the full' })
    const merged = mergePage([onScreen], read(rows), rows)
    expect(merged.map(text)).toEqual(['q', 'the full answer'])
    // The key is what the scroll position is anchored to: a new key would redraw the row and lose the reader's place
    expect(merged[1]!.seq).toBe(onScreen.seq)
  })

  it('keeps the screen text of a message still streaming past what history stored', () => {
    const rows = [said(1, 'q'), answered(2, 'Here is')]
    const merged = mergePage([live({ kind: 'assistant', storedSeq: 2, text: 'Here is the rest, still coming' })], read(rows), rows)
    expect(merged.map(text)).toEqual(['q', 'Here is the rest, still coming'])
  })

  it('takes history when the screen holds only the tail a reconnect replayed', () => {
    const rows = [said(1, 'q'), answered(2, 'The whole reply, start to end')]
    const merged = mergePage([live({ kind: 'assistant', storedSeq: 2, text: 'to end' })], read(rows), rows)
    expect(merged.map(text)).toEqual(['q', 'The whole reply, start to end'])
  })

  it('drops screen rows older than the page, which loading older pages brings back in place', () => {
    const rows = [said(10, 'L10'), answered(11, 'L11')]
    const stale = live({ kind: 'user', storedSeq: 3, text: 'L3' })
    const merged = mergePage([stale, live({ kind: 'assistant', storedSeq: 11, text: 'L11' })], read(rows), rows)
    expect(merged.map(text)).toEqual(['L10', 'L11'])
  })

  it('keeps an approval inside the page range at its numbered place, since history never draws one', () => {
    const rows = [said(1, 'L1'), answered(2, 'L2'), answered(4, 'L4')]
    const approval = live({ kind: 'approval', storedSeq: 3, requestId: 'r', summary: 'make' })
    const merged = mergePage([approval], read(rows), rows)
    expect(merged.map(text)).toEqual(['L1', 'L2', 'approval:make', 'L4'])
  })

  it('appends what streamed after the page, in order, below it', () => {
    const rows = [said(1, 'L1'), answered(2, 'L2')]
    const after = [
      live({ kind: 'user', storedSeq: 3, text: 'L3' }),
      live({ kind: 'assistant', text: 'streaming, not stored yet' }),
    ]
    expect(mergePage(after, read(rows), rows).map(text)).toEqual(['L1', 'L2', 'L3', 'streaming, not stored yet'])
  })

  it('a message sent before the host confirmed it is the page row with the same words, not a second copy', () => {
    const rows = [said(1, 'q'), answered(2, 'a'), said(3, 'and then?')]
    const sent = live({ kind: 'user', text: 'and then?', pending: true })
    const merged = mergePage([live({ kind: 'assistant', storedSeq: 2, text: 'a' }), sent], read(rows), rows)
    expect(merged.map(text)).toEqual(['q', 'a', 'and then?'])
    expect(merged[2]).toMatchObject({ seq: sent.seq, storedSeq: 3, pending: false })
  })

  it('a message with the same words from another session is not taken for the person\'s unconfirmed one', () => {
    const rows = [said(1, 'go')]
    rows[0]!.payload = { text: 'go', from: { sessionId: 'orch', name: 'Orchestrator' } }
    const merged = mergePage([live({ kind: 'user', text: 'go', pending: true })], read(rows), rows)
    expect(merged.map(text)).toEqual(['go', 'go'])
  })

  it('two screen rows for one stored number become one row', () => {
    const rows = [said(1, 'q'), answered(2, 'a')]
    const first = live({ kind: 'assistant', storedSeq: 2, text: 'a' })
    const merged = mergePage([first, live({ kind: 'assistant', storedSeq: 2, text: 'a' })], read(rows), rows)
    expect(merged.map(text)).toEqual(['q', 'a'])
    expect(merged[1]!.seq).toBe(first.seq)
  })

  it('a page row whose number is a render key already on screen gets a key of its own, and the screen row keeps its key', () => {
    const rows = [said(1, 'L1'), answered(2, 'L2'), said(3, 'L3')]
    const page = read(rows)
    // A live row that happens to carry render key 2 (the counter is shared by every session), not stored yet
    const clash = { kind: 'assistant', seq: 2, text: 'live' } as ChatItem
    const merged = mergePage([clash], page, rows)
    expect(merged.map(text)).toEqual(['L1', 'L2', 'L3', 'live'])
    expect(merged.find((i) => text(i) === 'live')!.seq).toBe(2)
    expect(keysUnique(merged)).toBe(true)
  })
})

describe('prependPage: an older page above the screen', () => {
  it('puts the older rows above, without a second copy of a number already on screen', () => {
    const have = [live({ kind: 'user', storedSeq: 3, text: 'L3' }), live({ kind: 'assistant', storedSeq: 4, text: 'L4' })]
    const older = read([said(1, 'L1'), answered(2, 'L2'), said(3, 'L3')])
    expect(prependPage(have, older).map(text)).toEqual(['L1', 'L2', 'L3', 'L4'])
  })

  it('leaves the screen rows and their keys as they were, and rekeys an older row that clashes', () => {
    const onScreen = { kind: 'assistant', seq: 1, storedSeq: 9, text: 'L9' } as ChatItem
    const merged = prependPage([onScreen], read([said(1, 'L1')]))
    expect(merged.map(text)).toEqual(['L1', 'L9'])
    expect(merged[1]).toBe(onScreen)
    expect(keysUnique(merged)).toBe(true)
  })
})

describe('readBack: the pages already read back above a re-read page', () => {
  const page = [said(101, 'L101'), answered(102, 'L102')]
  const readTo = (oldestSeq: number) => ({ oldestSeq, more: true, loading: false })

  it('keeps the rows from the cursor down to the page when the screen still connects to it', () => {
    const have = [
      live({ kind: 'user', storedSeq: 99, text: 'L99' }),
      live({ kind: 'assistant', storedSeq: 100, text: 'L100' }),
      live({ kind: 'user', storedSeq: 101, text: 'L101' }),
    ]
    expect(readBack(have, readTo(99), page).map(text)).toEqual(['L99', 'L100'])
  })

  it('keeps nothing when a gap of unknown size lies between the screen and the page', () => {
    const have = [live({ kind: 'user', storedSeq: 50, text: 'L50' }), live({ kind: 'assistant', storedSeq: 51, text: 'L51' })]
    expect(readBack(have, readTo(50), page)).toEqual([])
  })

  it('keeps nothing when the cursor is already at the page or nothing was read yet', () => {
    const have = [live({ kind: 'user', storedSeq: 101, text: 'L101' })]
    expect(readBack(have, readTo(101), page)).toEqual([])
    expect(readBack(have, undefined, page)).toEqual([])
    expect(readBack(have, readTo(1), [])).toEqual([])
  })
})

describe('trimWindow: a conversation nobody looks at, cut back to its window', () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => live({ kind: 'assistant', storedSeq: i + 1, text: `L${i + 1}` }))

  it('cuts nothing within the window', () => {
    expect(trimWindow(numbered(50))).toBeNull()
  })

  it('keeps the last fifty rows and moves the cursor to the first of them', () => {
    const cut = trimWindow(numbered(80))!
    expect(cut.items.map(text)).toEqual(numbered(80).slice(30).map(text))
    expect(cut.oldestSeq).toBe(31)
  })

  it('never starts the window on an unnumbered row, which has no number to read back from', () => {
    const items = numbered(60)
    items[10] = live({ kind: 'image', mime: 'image/png', data: 'AA' })
    const cut = trimWindow(items)!
    expect(cut.oldestSeq).toBe(12)
    expect(cut.items[0]!.storedSeq).toBe(12)
    expect(cut.items).toHaveLength(49)
  })

  it('cuts nothing when no row in the window has a number, since nothing could read the cut part back', () => {
    const items = Array.from({ length: 60 }, () => live({ kind: 'assistant', text: 'unnumbered' }))
    expect(trimWindow(items)).toBeNull()
  })
})
