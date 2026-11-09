import { describe, expect, it } from 'vitest'
import { CANARY, costOf, diffShapes, differs, earlierVersion, frameKind, mergeShapes, readFrames, shapeOf, toRerecord, unreadKinds, type Frame } from '../../../../../scripts/frames-canary.mjs'
import { CLAUDE_RECORDINGS } from '../claude/recorded.test-helpers.js'
import { CLAUDE_LIMITATIONS } from '../claude/surface.js'
import { recordedFolders } from './replay.test-helpers.js'
import { scenariosFor } from './scenarios.test-helpers.js'

/**
 * The recordings' canary (#1498 step 3, `scripts/frames-canary.mts`): what decides, without an agent's judgement, whether a new CLI
 * version needs more re-recorded than a few representative scenarios. It compares the frames' shape (kinds and field names),
 * never their values or timing, so two runs that differ only in what the model said read the same.
 */

const recorded = (name: string) => readFrames(`${CLAUDE_RECORDINGS}/claude-code-2.1.296/${name}.jsonl`)

const text = (t: string, id: string): Frame => ({ dir: 'in', msg: { type: 'assistant', session_id: id, message: { id, role: 'assistant', content: [{ type: 'text', text: t }] } } })
const delta = (t: string): Frame => ({ dir: 'in', msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } } })
const result = (cost: number): Frame => ({ dir: 'in', msg: { type: 'result', subtype: 'success', total_cost_usd: cost, usage: { input_tokens: 3 } } })

describe('the shape of a recording', () => {
  it('names a frame by its kinds, never by its values', () => {
    expect(frameKind(text('hello', 'a'))).toBe('in assistant:text')
    expect(frameKind(delta('x'))).toBe('in stream_event:content_block_delta/text_delta')
    expect(frameKind({ dir: 'out', msg: { request_id: 'rid-1', type: 'control_request', request: { subtype: 'initialize' } } })).toBe('out control_request:initialize')
    expect(frameKind({ dir: 'exit', msg: { code: 0, sig: null } })).toBe('exit')
    // Codex's JSON-RPC: a request by its method and item, its answer by the method it answers
    const methods = new Map<string, string>()
    expect(frameKind({ dir: 'out', msg: { id: 7, method: 'turn/start', params: {} } }, methods)).toBe('out turn/start')
    expect(frameKind({ dir: 'in', msg: { id: 7, result: { turn: {} } } }, methods)).toBe('in result:turn/start')
    expect(frameKind({ dir: 'in', msg: { method: 'item/started', params: { item: { type: 'reasoning', id: 'x' } } } }, methods)).toBe('in item/started:reasoning')
  })

  it('reads two runs that differ only in what was said, and in how many deltas it streamed, as the same', () => {
    const a = shapeOf([delta('he'), delta('llo'), text('hello', 'a'), result(0.001)])
    const b = shapeOf([delta('a much longer answer'), delta(' in'), delta(' three'), text('a much longer answer in three', 'b'), result(0.002)])
    expect(differs(diffShapes(a, b))).toBe(false)
  })

  it('says a kind of frame that is gone or new, and a field every frame had that is gone; a new field is printed, not counted', () => {
    const before = shapeOf([text('a', 'a'), result(0.001)])
    const gone = diffShapes(before, shapeOf([result(0.001)]))
    expect(gone.gone).toEqual(['in assistant:text'])
    const added = diffShapes(before, shapeOf([delta('a'), text('a', 'a'), result(0.001)]))
    expect(added.added).toEqual(['in stream_event:content_block_delta/text_delta'])
    const renamed: Frame = { dir: 'in', msg: { type: 'result', subtype: 'success', cost_usd: 0.001, usage: { input_tokens: 3 } } }
    const d = diffShapes(before, shapeOf([text('a', 'a'), renamed]))
    expect(d.fields).toEqual([{ kind: 'in result:success', gone: ['total_cost_usd'], added: ['cost_usd'] }])
    expect(differs(d)).toBe(true)
    const more: Frame = { dir: 'in', msg: { type: 'result', subtype: 'success', total_cost_usd: 0.001, usage: { input_tokens: 3 }, diagnostics: {} } }
    expect(differs(diffShapes(before, shapeOf([text('a', 'a'), more])))).toBe(false)
  })

  it('reads what a run may leave out as no change: a field only some frames had, the exit, a kind the adapter drops, ids used as keys', () => {
    const limit = (u?: number): Frame => ({ dir: 'in', msg: { type: 'rate_limit_event', rate_limit_info: u === undefined ? { status: 'allowed' } : { status: 'allowed', utilization: u } } })
    expect(differs(diffShapes(shapeOf([limit(0.9), limit()]), shapeOf([limit()])))).toBe(false)
    expect(differs(diffShapes(shapeOf([limit(0.9)]), shapeOf([limit()])))).toBe(true)
    expect(differs(diffShapes(shapeOf([result(0.001), { dir: 'exit', msg: {} }]), shapeOf([result(0.001)])))).toBe(false)
    const commands: Frame = { dir: 'in', msg: { type: 'system', subtype: 'commands_changed', commands: [] } }
    const unread = unreadKinds('claude', CLAUDE_LIMITATIONS)
    expect(unread).toContain('in system:commands_changed')
    expect(diffShapes(shapeOf([commands, result(0.001)]), shapeOf([result(0.001)]), unread).gone).toEqual([])
    const inputs = (id: string): Frame => ({ dir: 'in', msg: { type: 'result', subtype: 'success', modelUsage: { 'claude-haiku-5-5': { costUSD: 1 } }, wire_tool_inputs: { [id]: { command: 'ls' } } } })
    expect(differs(diffShapes(shapeOf([inputs('toolu_01QjToWWW6xXUPcfZfSq8ffz')]), shapeOf([inputs('toolu_012DA1wgjh8WkTFgknrUwnbh')])))).toBe(false)
  })

  it("compares the canary scenarios as one set: thinking before a plain answer on one run and not the next is the model's choice", () => {
    const thought: Frame = { dir: 'in', msg: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } } }
    const before = mergeShapes([shapeOf([thought, text('a', 'a')]), shapeOf([thought])])
    expect(differs(diffShapes(before, mergeShapes([shapeOf([text('a', 'a')]), shapeOf([thought])])))).toBe(false)
  })

  it('finds the same shape in a recording compared with itself, and differences between two scenarios', () => {
    expect(differs(diffShapes(shapeOf(recorded('basic')), shapeOf(recorded('basic'))))).toBe(false)
    expect(differs(diffShapes(shapeOf(recorded('basic')), shapeOf(recorded('approval'))))).toBe(true)
  })
})

describe('what the canary asks to re-record', () => {
  it('nothing when no canary scenario differs', () => {
    const set = mergeShapes(CANARY.claude!.map((n) => shapeOf(recorded(n))))
    const tools = new Map([['tools', shapeOf(recorded('tools'))]])
    expect(toRerecord(diffShapes(set, set), tools, tools)).toEqual([])
  })

  it('every earlier scenario whose frames hold a kind that lost a field, and the canary scenario that showed a new kind, not the others', () => {
    const before = shapeOf([text('a', 'a'), result(0.001)])
    const changed: Frame = { dir: 'in', msg: { type: 'result', subtype: 'success', cost: 1 } }
    const now = new Map([
      ['basic', shapeOf([text('a', 'a'), changed])],
      ['thinking', shapeOf([delta('a'), text('a', 'a')])],
    ])
    const earlier = new Map([
      ['tools', shapeOf([result(0.001)])],
      ['plan', shapeOf([{ dir: 'out', msg: { type: 'control_request', request: { subtype: 'interrupt' } } }])],
    ])
    expect(toRerecord(diffShapes(before, mergeShapes(now.values())), earlier, now)).toEqual(['thinking', 'tools'])
  })

  it('compares with the newest earlier version that holds every canary scenario', () => {
    const versions = ['2.1.296', '2.1.316', '2.1.300', '2.1.4']
    expect(earlierVersion(versions, '2.1.316', (v) => v !== '2.1.300')).toBe('2.1.296')
    expect(earlierVersion(versions, '2.1.296', () => true)).toBe('2.1.4')
    expect(earlierVersion(versions, '2.1.4', () => true)).toBeNull()
  })
})

describe('the canary scenarios', () => {
  it('are scenarios each tool records, and recorded on the version the next canary compares with', () => {
    for (const [tool, names] of Object.entries(CANARY)) for (const n of names) expect(scenariosFor(tool).map((s) => s.name), `${tool} ${n}`).toContain(n)
    const folder = recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === 'claude-code-2.1.296')
    expect(folder?.names).toEqual(expect.arrayContaining([...CANARY.claude!]))
  })

  it("counts a run's cost from Claude Code's own running total, per process", () => {
    expect(costOf([result(0.001), result(0.003), { dir: 'exit', msg: {} }, result(0.002)])).toBeCloseTo(0.005)
    expect(costOf([text('a', 'a')])).toBeNull()
    expect(costOf(recorded('basic'))).toBeGreaterThan(0)
  })
})
