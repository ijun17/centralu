import { describe, expect, it } from 'vitest'
import {
  analyse,
  budgetBreaches,
  chordKeys,
  compareReports,
  encode,
  fittsSeconds,
  formatReport,
  hick,
  makeReport,
  operatorString,
  pointing,
  SECONDS,
  strokesOf,
  widthAlong,
  type Access,
  type Report,
  type Step,
  type TaskResult,
} from '../e2e/ux/klm.js'

/** The task-cost model (#518, e2e/ux/klm.ts, docs/ux-metrics.md) */

const ops = (steps: Step[], hand: 'keyboard' | 'mouse' = 'keyboard') => operatorString(encode(steps, hand))
const press = (chord: string, extra: Partial<Extract<Step, { kind: 'press' }>> = {}): Step => ({ kind: 'press', label: chord, keys: chordKeys(chord), ...extra })
const type = (text: string, string: 'constant' | 'variable' = 'variable'): Step => ({ kind: 'type', label: text, text, strokes: strokesOf(text), string })
const at = (x: number, y: number) => ({ x, y })
const box = { x: 100, y: 100, width: 40, height: 20 }
const click = (role: 'command' | 'argument' = 'command', extra: Partial<Extract<Step, { kind: 'click' }>> = {}): Step => ({
  kind: 'click',
  label: 'target',
  role,
  pointing: pointing(at(0, 0), box),
  ...extra,
})

describe("Fitts's law", () => {
  it('is a + b·log2(D/W + 1) with a = 0.8 s and b = 0.1 s/bit', () => {
    // D/W = 7 is 3 bits: the KLM's average P of 1.1 s, which is what a was chosen for
    expect(fittsSeconds(7, 1)).toBeCloseTo(1.1, 10)
    expect(fittsSeconds(0, 10)).toBeCloseTo(0.8, 10)
    expect(fittsSeconds(15, 1)).toBeCloseTo(1.2, 10)
  })

  it('reads the width along the line of approach', () => {
    const b = { x: 0, y: 0, width: 80, height: 20 }
    expect(widthAlong(b, 1, 0)).toBe(80) // level: the button's width
    expect(widthAlong(b, 0, 1)).toBe(20) // from above: its height
    expect(widthAlong(b, -1, 0)).toBe(80) // from the right, the same
    // At 45°, the chord leaves through the top and bottom edges: 20 / sin 45°
    expect(widthAlong(b, 1, 1)).toBeCloseTo(20 * Math.SQRT2, 10)
    // Shallow enough and it leaves through the sides: 80 / cos θ
    expect(widthAlong(b, 10, 1)).toBeCloseTo(80 / (10 / Math.hypot(10, 1)), 10)
  })

  it('measures from the pointer to the centre of the target', () => {
    const p = pointing(at(0, 120), { x: 300, y: 100, width: 40, height: 40 })!
    expect(p.to).toEqual({ x: 320, y: 120 })
    expect(p.D).toBe(320)
    expect(p.W).toBe(40)
    expect(p.ID).toBeCloseTo(Math.log2(9), 10)
    expect(p.seconds).toBeCloseTo(0.8 + 0.1 * Math.log2(9), 10)
  })

  it('costs no pointing when the pointer is already on the target', () => {
    expect(pointing(at(110, 105), box)).toBeNull()
    expect(ops([{ kind: 'click', label: 'here', role: 'command', pointing: null }], 'mouse')).toBe('M B B')
  })
})

describe('Hick–Hyman', () => {
  it('is 0.15 s per bit of log2(n + 1)', () => {
    expect(hick(1)).toEqual({ n: 1, bits: 1, seconds: 0.15 })
    expect(hick(7).bits).toBe(3)
    expect(hick(7).seconds).toBeCloseTo(0.45, 10)
  })

  it('is a note on the task, never part of its time', () => {
    const r = analyse({ id: 't', task: 't', path: 'keyboard', access: 'shortcut' }, [press('Enter', { choice: hick(7) })], 'keyboard')
    expect(r.seconds).toBeCloseTo(SECONDS.M + SECONDS.K, 10)
    expect(r.notes).toEqual(['Enter: a choice among 7 (Hick–Hyman 0.45 s, not added)'])
  })
})

describe('keys', () => {
  it('counts a chord as its keys, and a lone plus as a key', () => {
    expect(chordKeys('ControlOrMeta+Shift+a')).toEqual(['ControlOrMeta', 'Shift', 'a'])
    expect(chordKeys('Enter')).toEqual(['Enter'])
    expect(chordKeys('+')).toEqual(['+'])
    expect(chordKeys('Shift++')).toEqual(['Shift', '+'])
  })

  it('counts Shift for a capital or a shifted symbol', () => {
    expect(strokesOf('fix it')).toBe(6)
    expect(strokesOf('Fix it!')).toBe(9)
    expect(strokesOf('me@box')).toBe(7)
  })
})

describe('hand switches (H)', () => {
  it('moves the hand only when the device changes', () => {
    expect(ops([press('y')], 'keyboard')).toBe('M K')
    expect(ops([press('y')], 'mouse')).toBe('H M K')
    expect(ops([click(), click()], 'keyboard')).toBe('H M P B B M P B B')
    expect(ops([click('argument'), type('hi'), click()], 'mouse')).toBe('P B B H K K H M P B B')
  })

  it('does not count a wait as using either device', () => {
    expect(ops([press('ControlOrMeta+k'), { kind: 'wait', label: 'palette', ms: 40 }, type('abc')])).toBe('M K K R 3K')
  })
})

describe("placing M (Card, Moran & Newell's rules)", () => {
  it('Rule 0: an M before a command key and before pointing at a command, none inside a typed string', () => {
    expect(ops([press('ControlOrMeta+k')])).toBe('M K K')
    expect(ops([type('hello')])).toBe('5K')
    expect(ops([click('command')], 'mouse')).toBe('M P B B')
  })

  it('Rule 0: no M before pointing at an argument (placing the caret)', () => {
    expect(ops([click('argument')], 'mouse')).toBe('P B B')
  })

  it('Rule 1: an M after a pointing that anticipates the next key is deleted (P M K → P K)', () => {
    const point: Step = { kind: 'point', label: 'hover', pointing: pointing(at(0, 0), box) }
    expect(ops([point, press('Delete')], 'mouse')).toBe('P H K')
    // A key after a finished click is a new decision: the click ends in B, not P
    expect(ops([click('argument'), press('Delete')], 'mouse')).toBe('P B B H M K')
  })

  it('Rule 1: a click never has an M between its pointing and its button', () => {
    expect(encode([click()], 'mouse').map((o) => o.op)).toEqual(['M', 'P', 'B', 'B'])
  })

  it('Rule 2: a chord is one cognitive unit, and so is a key marked as continuing the one before', () => {
    expect(ops([press('ControlOrMeta+Shift+a')])).toBe('M 3K')
    expect(ops([press('ArrowDown'), press('ArrowDown', { continues: true }), press('Enter', { continues: true })])).toBe('M 3K')
    expect(ops([click(), click('command', { continues: true, pointing: null })], 'mouse')).toBe('M P 4B')
  })

  it('Rule 3: a redundant terminator gets no M', () => {
    expect(ops([press('Enter'), press('Enter', { redundant: true })])).toBe('M K K')
  })

  it('Rule 4: the key ending a variable string keeps its M, the one ending a constant string loses it', () => {
    expect(ops([type('abc', 'variable'), press('Enter')])).toBe('3K M K')
    expect(ops([type('abc', 'constant'), press('Enter')])).toBe('4K')
    // A wait between the string and its terminator does not change what the key terminates
    expect(ops([type('abc', 'constant'), { kind: 'wait', label: 'hits', ms: 5 }, press('Enter')])).toBe('3K R K')
  })

  it('places the M after the hand arrives, before the operator it prepares', () => {
    expect(ops([type('a'), click()])).toBe('K H M P B B')
  })

  it('a drag is one command: one M, then pointing at the thing, press, carrying it, release', () => {
    const drag: Step = {
      kind: 'drag',
      label: 'row → grid',
      grab: pointing(at(0, 0), box),
      drop: pointing(at(120, 110), { x: 400, y: 300, width: 600, height: 400 }),
    }
    expect(ops([drag])).toBe('H M P B P B')
    // Already on the thing: no first pointing, and the M stays because nothing before anticipates it
    expect(ops([{ ...drag, grab: null }], 'mouse')).toBe('M B P B')
    const r = analyse({ id: 'd', task: 'd', path: 'mouse', access: 'discoverable' }, [drag], 'mouse')
    expect(r.travelPx).toBe(Math.round(drag.grab!.D + drag.drop!.D))
    expect(r.seconds).toBeCloseTo(SECONDS.M + 2 * SECONDS.B + drag.grab!.seconds + drag.drop!.seconds, 2)
  })
})

describe('the operator string', () => {
  it('writes runs of three or more once, with their count', () => {
    const o = (s: string) => s.split(' ').map((op) => ({ op: op as 'K', seconds: 0, step: 0 }))
    expect(operatorString(o('M K K'))).toBe('M K K')
    expect(operatorString(o('M K K K B B'))).toBe('M 3K B B')
  })
})

describe('a task', () => {
  const steps: Step[] = [
    { kind: 'click', label: 'row', role: 'command', pointing: pointing(at(640, 420), { x: 10, y: 200, width: 200, height: 28 }) },
    { kind: 'wait', label: 'session', ms: 12.4 },
    { kind: 'click', label: 'composer', role: 'argument', pointing: pointing(at(110, 214), { x: 300, y: 700, width: 800, height: 60 }) },
    type('Ship it'),
    press('Enter'),
    { kind: 'wait', label: 'goal', ms: 30.2 },
  ]
  const r = analyse({ id: 'send.mouse', task: 'Send', path: 'mouse', access: 'discoverable' }, steps, 'keyboard')

  it('sums its operators into KLM time, leaving R out', () => {
    const P = steps.reduce((t, s) => t + (s.kind === 'click' && s.pointing ? s.pointing.seconds : 0), 0)
    expect(r.operators).toBe('H M P B B P B B H 8K M K')
    expect(r.counts).toEqual({ K: 9, P: 2, B: 4, H: 2, M: 2, R: 2 })
    expect(r.seconds).toBeCloseTo(2 * SECONDS.H + 2 * SECONDS.M + 9 * SECONDS.K + 4 * SECONDS.B + P, 2)
    expect(r.waitMs).toBe(43)
  })

  it('adds up the pointer travel and says where each step went', () => {
    const d1 = Math.hypot(640 - 110, 420 - 214)
    const d2 = Math.hypot(700 - 110, 730 - 214)
    expect(r.travelPx).toBe(Math.round(d1 + d2))
    expect(r.steps.map((s) => s.operators)).toEqual(['H M P B B', 'R', 'P B B', 'H 8K', 'M K', 'R'])
    expect(r.steps[0]!.pointer!.D).toBe(Math.round(d1))
  })
})

describe('budgets', () => {
  const r = { seconds: 5.6, travelPx: 800, counts: { K: 4, P: 2, B: 4, H: 1, M: 2, R: 3 } }

  it('passes within every bound, and when none is declared', () => {
    expect(budgetBreaches(r, { seconds: 5.6, operators: 13, M: 2, H: 1, travelPx: 800 })).toEqual([])
    expect(budgetBreaches(r, undefined)).toEqual([])
  })

  it('names every bound it goes over; R never counts as an operator', () => {
    expect(budgetBreaches(r, { seconds: 5.5, operators: 12, H: 0, travelPx: 799, K: 3 })).toEqual([
      'KLM time 5.6 s > budget 5.5 s',
      'operators 13 > budget 12',
      'pointer travel 800 px > budget 799 px',
      'K 4 > budget 3',
      'H 1 > budget 0',
    ])
  })
})

describe('the report', () => {
  const task = (id: string, operators: string, seconds: number, K: number, access: Access = 'shortcut'): TaskResult => ({
    id,
    task: id,
    path: 'keyboard',
    access,
    operators,
    counts: { K, P: 0, B: 0, H: 0, M: 1, R: 1 },
    seconds,
    waitMs: 10,
    travelPx: 0,
    steps: [],
    notes: [],
    breaches: [],
  })
  const before = makeReport('webkit', [task('b.keyboard', 'M K K', 1.91, 2), task('a.keyboard', 'M 3K', 2.19, 3)], [])
  const after = makeReport('webkit', [task('b.keyboard', 'M K', 1.63, 1), task('c.keyboard', 'M K', 1.63, 1)], [
    { id: 'd.mouse', task: 'd', path: 'mouse', access: 'discoverable', waitingOn: '#1', reason: 'not merged' },
  ])

  it('is sorted by task and lists the pending tasks after them', () => {
    expect(before.tasks.map((t) => t.id)).toEqual(['a.keyboard', 'b.keyboard'])
    const text = formatReport(after)
    expect(text).toContain('| b.keyboard | keyboard | `M K` | 1 | 0 | 0 | 0 | 1 | 2 | 1.63 | 0 | 1 (10) |')
    expect(text).toContain('| d.mouse | discoverable | mouse | #1 | not merged |')
  })

  it('compares two runs task by task, including tasks only one of them has', () => {
    const text = compareReports(before, after)
    expect(text).toContain('| a.keyboard | 4 → removed | 2.19 → — |')
    expect(text).toContain('| b.keyboard | 3 → 2 | 1.91 → 1.63 | −0.28 | ±0 | `M K` (was `M K K`) |')
    expect(text).toContain('| c.keyboard | added → 2 | — → 1.63 |')
  })

  /*
   * Owner, 2026-10-12: a shortcut is known only to people who already know it, so the numbers that
   * stand for a task are its discoverable path's, and an expert path never sits among them.
   */
  const mixed = makeReport('webkit', [task('z.mouse', 'H M P B B', 2.9, 0, 'discoverable'), task('a.keyboard', 'M K K', 1.91, 2)], [])

  it('puts the discoverable paths first and the shortcut paths in a section of their own', () => {
    const text = formatReport(mixed)
    const discoverable = text.indexOf('#### Discoverable paths')
    const expert = text.indexOf('#### Expert paths')
    expect(discoverable).toBe(0)
    expect(expert).toBeGreaterThan(discoverable)
    expect(text.indexOf('| z.mouse |')).toBeGreaterThan(discoverable)
    expect(text.indexOf('| z.mouse |')).toBeLessThan(expert)
    expect(text.indexOf('| a.keyboard |')).toBeGreaterThan(expert)
  })

  it('groups a comparison the same way, taking the tags a version 1 report lacks from the other run', () => {
    const untagged: Report = { ...mixed, tasks: mixed.tasks.map(({ access: _, ...t }) => t as TaskResult) }
    const text = compareReports(untagged, mixed)
    const expert = text.indexOf('#### Expert paths')
    expect(text.indexOf('#### Discoverable paths')).toBe(0)
    expect(text.indexOf('| z.mouse |')).toBeLessThan(expert)
    expect(text.indexOf('| a.keyboard |')).toBeGreaterThan(expert)
  })
})
