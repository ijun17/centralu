import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../store/store.js'
import { answerEnds, bubbleOf, dayBreaks, joinsNext } from './answerBubble.js'

/*
 * The agent's answer as a bubble (owner, 2026-10-18): its text rows share one bubble, drawn in pieces; tool calls,
 * reasoning, images and markers stand outside it and split it; the answer's time goes under its last bubble only;
 * a divider names each new day.
 */

let key = 0
const user = (at?: number): ChatItem => ({ kind: 'user', seq: ++key, text: 'ask', ...(at === undefined ? {} : { at }) })
const said = (at?: number): ChatItem => ({ kind: 'assistant', seq: ++key, text: 'answer', ...(at === undefined ? {} : { at }) })
const thought = (): ChatItem => ({ kind: 'reasoning', seq: ++key, text: 'thinking' })
const call = (at?: number): ChatItem => ({ kind: 'tool', seq: ++key, tool: 'Bash', title: 'ls', ...(at === undefined ? {} : { at }) })
const image = (): ChatItem => ({ kind: 'image', seq: ++key, mime: 'image/png', data: 'AAAA' })
const mark = (): ChatItem => ({ kind: 'mark', seq: ++key, text: 'compacted' })

const parts = (chat: ChatItem[]) => chat.map((_, i) => bubbleOf(chat, i))

describe('bubbleOf', () => {
  it('draws a lone answer row as a whole bubble, and nothing else as one', () => {
    expect(parts([user(), said()])).toEqual([null, 'solo'])
    expect(parts([call(), thought(), image(), mark()])).toEqual([null, null, null, null])
  })

  it('joins answer rows in a row into one bubble: first, the ones between, last', () => {
    expect(parts([user(), said(), said(), said(), user()])).toEqual([null, 'first', 'mid', 'last', null])
    expect(parts([said(), said()])).toEqual(['first', 'last'])
  })

  it('splits the bubble at a tool call, a reasoning summary, an image or a marker', () => {
    for (const between of [call(), thought(), image(), mark()]) {
      expect(parts([said(), between, said()])).toEqual(['solo', null, 'solo'])
    }
  })

  it('lets no gap stand inside a bubble: only its first and middle pieces run on', () => {
    expect(['solo', 'first', 'mid', 'last', null].map((p) => joinsNext(p as never))).toEqual([false, true, true, false, false])
  })
})

describe('answerEnds', () => {
  it('marks the last answer bubble before the person speaks again, once per answer', () => {
    // One answer split by tool calls into three bubbles: the time goes under the last only
    const chat = [user(), said(), call(), said(), call(), said(), user(), said(), said()]
    expect([...answerEnds(chat)].sort((a, b) => a - b)).toEqual([5, 8])
  })

  it('marks no row in an answer that said nothing in words, and the last bubble when tool calls follow it', () => {
    expect([...answerEnds([user(), call(), call()])]).toEqual([])
    expect([...answerEnds([user(), said(), call(), thought()])]).toEqual([1])
  })
})

describe('dayBreaks', () => {
  const day = (d: number, h = 12) => new Date(2026, 9, d, h, 0).getTime()

  it('names the day where the conversation begins and where each new day begins', () => {
    const chat = [user(day(17, 9)), said(day(17, 23)), user(day(18, 0)), call(day(18, 1)), said(day(20))]
    expect([...dayBreaks(chat)]).toEqual([
      [0, 'Saturday, October 17, 2026'],
      [2, 'Sunday, October 18, 2026'],
      [4, 'Tuesday, October 20, 2026'],
    ])
  })

  it('never starts a day on a row with no time, and reads the day on from the last time before it', () => {
    const chat = [said(), user(day(18)), mark(), said(day(18, 15)), thought(), user(day(19))]
    expect([...dayBreaks(chat)]).toEqual([
      [1, 'Sunday, October 18, 2026'],
      [5, 'Monday, October 19, 2026'],
    ])
  })

  it('draws no divider in a conversation with no times', () => {
    expect(dayBreaks([user(), said(), call()]).size).toBe(0)
  })
})
