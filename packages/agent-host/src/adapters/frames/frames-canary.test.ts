import { describe, expect, it } from 'vitest'
import {
  CANARY,
  compareVersions,
  costOf,
  diffShapes,
  differs,
  earlierVersion,
  frameKind,
  kindMatches,
  readFrames,
  RULES,
  shapeOf,
  toRerecord,
  unreadKinds,
  type Frame,
  type Rules,
  type Shape,
} from '../../../../../scripts/frames-canary.mjs'
import { CLAUDE_RECORDINGS } from '../claude/recorded.test-helpers.js'
import { CLAUDE_LIMITATIONS } from '../claude/surface.js'
import { CODEX_RECORDINGS } from '../codex/recorded.test-helpers.js'
import { recordedFolders } from './replay.test-helpers.js'
import { scenariosFor } from './scenarios.test-helpers.js'

/**
 * The recordings' canary (#1498 step 3, `scripts/frames-canary.mts`): what decides, without an agent's judgement, whether a new CLI
 * version needs more re-recorded than a few representative scenarios. It compares each scenario with itself on the earlier
 * version by what the adapter depends on (kinds, fields, the fields it reads, their types, the values it tells apart, the order
 * within a turn), never by text, ids or timing, so two runs that differ only in what the model said read the same.
 */

const recorded = (version: string, name: string) => readFrames(`${CLAUDE_RECORDINGS}/claude-code-${version}/${name}.jsonl`)
const claude = RULES.claude!

const text = (t: string, id: string): Frame => ({ dir: 'in', msg: { type: 'assistant', session_id: id, message: { id, role: 'assistant', content: [{ type: 'text', text: t }] } } })
const delta = (t: string): Frame => ({ dir: 'in', msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } } })
const result = (cost: number, more: Record<string, unknown> = {}): Frame => ({ dir: 'in', msg: { type: 'result', subtype: 'success', total_cost_usd: cost, usage: { input_tokens: 3 }, ...more } })
const prompt = (t: string): Frame => ({ dir: 'out', msg: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } } })
const start = (uuid?: string): Frame => ({ dir: 'in', msg: { type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } }, ...(uuid ? { user_message_uuid: uuid } : {}) } })
const stop = (reason: string | null): Frame => ({ dir: 'in', msg: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } } } })
const thought: Frame = { dir: 'in', msg: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } } }
const status: Frame = { dir: 'in', msg: { type: 'system', subtype: 'status', status: 'requesting' } }

/** A comparison with Claude Code's rules, as the canary makes it */
const diff = (before: readonly Frame[], now: readonly Frame[], o: { scenario?: string; known?: Set<string>; rules?: Rules } = {}) =>
  diffShapes(shapeOf(before, o.rules ?? claude), shapeOf(now, o.rules ?? claude), { rules: o.rules ?? claude, unread: unreadKinds('claude', CLAUDE_LIMITATIONS), ...o })

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

  it('splits a recording into turns at each prompt sent', () => {
    expect(shapeOf([status, prompt('a'), delta('x'), result(0), prompt('b'), result(0)]).turns).toEqual([
      ['in system:status'],
      ['out user:text', 'in stream_event:content_block_delta/text_delta', 'in result:success'],
      ['out user:text', 'in result:success'],
    ])
  })

  it('reads two runs that differ only in what was said, and in how many deltas it streamed, as the same', () => {
    const a = [prompt('a'), delta('he'), delta('llo'), text('hello', 'a'), result(0.001)]
    const b = [prompt('b'), delta('a much longer answer'), delta(' in'), delta(' three'), text('a much longer answer in three', 'b'), result(0.002)]
    expect(differs(diff(a, b))).toBe(false)
  })

  it('says a kind of frame that is gone or new, and a field every frame had that is gone; a new field is printed, not counted', () => {
    const before = [status, result(0.001)]
    expect(diff(before, [result(0.001)]).gone).toEqual(['in system:status'])
    const extra: Frame = { dir: 'in', msg: { type: 'system', subtype: 'brand_new' } }
    expect(diff(before, [status, extra, result(0.001)]).added).toEqual(['in system:brand_new'])
    const renamed: Frame = { dir: 'in', msg: { type: 'result', subtype: 'success', cost_usd: 0.001, usage: { input_tokens: 3 } } }
    const d = diff(before, [status, renamed])
    expect(d.fields).toEqual([{ kind: 'in result:success', gone: ['total_cost_usd'], added: ['cost_usd'] }])
    expect(differs(d)).toBe(true)
    expect(differs(diff(before, [status, result(0.001, { diagnostics: {} })]))).toBe(false)
  })

  it('reads what a run may leave out as no change: a field only some frames had, the exit, a kind the adapter drops, ids used as keys, an empty list', () => {
    const task = (extra: Record<string, unknown>): Frame => ({ dir: 'in', msg: { type: 'system', subtype: 'task_progress', ...extra } })
    expect(differs(diff([task({ last_tool_name: 'Bash' }), task({})], [task({})]))).toBe(false)
    expect(differs(diff([task({ last_tool_name: 'Bash' })], [task({})]))).toBe(true)
    expect(differs(diff([result(0.001), { dir: 'exit', msg: {} }], [result(0.001)]))).toBe(false)
    const commands: Frame = { dir: 'in', msg: { type: 'system', subtype: 'commands_changed', commands: [] } }
    expect(unreadKinds('claude', CLAUDE_LIMITATIONS)).toContain('in system:commands_changed')
    expect(diff([commands, result(0.001)], [result(0.001)]).gone).toEqual([])
    const inputs = (id: string): Frame => ({ dir: 'in', msg: { type: 'result', subtype: 'success', modelUsage: { 'claude-haiku-5-5': { costUSD: 1 } }, wire_tool_inputs: { [id]: { command: 'ls' } } } })
    expect(differs(diff([inputs('toolu_01QjToWWW6xXUPcfZfSq8ffz')], [inputs('toolu_012DA1wgjh8WkTFgknrUwnbh')]))).toBe(false)
    // The servers a run had: their fields are not gone when the list is empty now, and are when its items lack them
    const init = (servers: unknown[]): Frame => ({ dir: 'in', msg: { type: 'system', subtype: 'init', mcp_servers: servers } })
    expect(differs(diff([init([{ name: 'a', status: 'connected' }])], [init([])]))).toBe(false)
    expect(diff([init([{ name: 'a', status: 'connected' }])], [init([{ status: 'connected' }])]).fields[0]?.gone).toEqual(['mcp_servers[].name'])
  })
})

describe('each scenario compared with itself', () => {
  it('counts a kind gone from one scenario though another scenario still sends it', () => {
    const before = new Map([
      ['basic', shapeOf([prompt('a'), status, result(0)], claude)],
      ['approval', shapeOf([prompt('a'), status, result(0)], claude)],
    ])
    const now = new Map([
      ['basic', shapeOf([prompt('a'), status, result(0)], claude)],
      ['approval', shapeOf([prompt('a'), result(0)], claude)],
    ])
    const diffs = compareVersions(before, now, { rules: claude })
    expect(diffs.get('approval')!.gone).toEqual(['in system:status'])
    expect(differs(diffs.get('basic')!)).toBe(false)
    expect(toRerecord(diffs, before)).toEqual(['approval', 'basic'])
  })

  it("does not count thinking the model chose not to do, but does in the scenario that asks for it", () => {
    const before = [prompt('a'), thought, text('a', 'a'), result(0)]
    const now = [prompt('a'), text('a', 'a'), result(0)]
    expect(differs(diff(before, now, { scenario: 'basic' }))).toBe(false)
    expect(diff(before, now, { scenario: 'thinking' }).gone).toEqual(['in assistant:thinking'])
  })

  it('counts a kind as new only when no recording of the earlier version holds it', () => {
    const now = [prompt('a'), thought, text('a', 'a'), result(0)]
    expect(diff([prompt('a'), text('a', 'a'), result(0)], now, { known: new Set(['in assistant:thinking']) }).added).toEqual([])
    expect(diff([prompt('a'), text('a', 'a'), result(0)], now, { known: new Set() }).added).toEqual(['in assistant:thinking'])
  })
})

describe('what the adapter depends on', () => {
  it('counts a field the adapter reads gone from every frame, though not every earlier frame had it', () => {
    // Only the message that starts a turn names the input it runs for
    const before = [prompt('a'), start('u1'), stop('end_turn'), start(), stop('end_turn'), result(0)]
    const now = [prompt('a'), start(), stop('end_turn'), start(), stop('end_turn'), result(0)]
    const d = diff(before, now)
    expect(d.read).toEqual([{ kind: 'in stream_event:message_start', fields: ['user_message_uuid'] }])
    expect(differs(d)).toBe(true)
    // The same for a field the adapter does not read is a run's choice
    expect(differs(diff(before, now, { rules: { ...claude, read: {} } }))).toBe(false)
  })

  it("counts a field's new JSON type, not a null where a value was or a value where only null was", () => {
    const usage = (n: unknown): Frame => ({ dir: 'in', msg: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: n } } } })
    expect(diff([usage(3)], [usage('3')]).types).toEqual([{ kind: 'in stream_event:message_delta', field: 'event.usage.output_tokens', before: ['number'], now: ['string'] }])
    expect(differs(diff([usage(3)], [usage(null)]))).toBe(false)
    expect(differs(diff([usage(null)], [usage({ n: 3 })]))).toBe(false)
  })

  it('counts a value the adapter tells apart that the earlier recording never had, and only for those fields', () => {
    const d = diff([stop('end_turn'), stop('tool_use')], [stop('end_turn'), stop('model_context_window_exceeded')])
    expect(d.values).toEqual([{ kind: 'in stream_event:message_delta', field: 'event.delta.stop_reason', added: ['model_context_window_exceeded'] }])
    expect(differs(diff([stop('end_turn'), stop('tool_use')], [stop('end_turn')]))).toBe(false)
    // The behavior Centralu answers a permission request with
    const answer = (behavior: string): Frame => ({ dir: 'out', msg: { type: 'control_response', response: { subtype: 'success', response: { behavior } } } })
    expect(diff([answer('allow'), answer('deny')], [answer('allow'), answer('ask')]).values).toEqual([{ kind: 'out control_response:success', field: 'response.response.behavior', added: ['ask'] }])
    // A field outside the list may take any value
    const task = (s: string): Frame => ({ dir: 'in', msg: { type: 'system', subtype: 'task_progress', last_tool_name: s } })
    expect(differs(diff([task('Bash')], [task('Read')]))).toBe(false)
  })

  it('counts another order of the kinds sent once in a turn, not of those sent several times or by a timer', () => {
    const tool: Frame = { dir: 'in', msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } } }
    const asked: Frame = { dir: 'in', msg: { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash' } } }
    const d = diff([prompt('a'), asked, tool, result(0)], [prompt('a'), tool, asked, result(0)])
    expect(d.order).toEqual([{ turn: 1, before: ['out user:text', 'in control_request:can_use_tool', 'in user:tool_result', 'in result:success'], now: ['out user:text', 'in user:tool_result', 'in control_request:can_use_tool', 'in result:success'] }])
    // Text said before a call, and after it: no one place
    expect(differs(diff([prompt('a'), delta('x'), asked, delta('y'), result(0)], [prompt('a'), asked, delta('x'), delta('y'), result(0)]))).toBe(false)
    const limit: Frame = { dir: 'in', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } }
    expect(differs(diff([prompt('a'), limit, asked, result(0)], [prompt('a'), asked, limit, result(0)]))).toBe(false)
  })

  it("does not count a field gone from what follows the account's state, unless the adapter reads it", () => {
    const limit = (info: Record<string, unknown>): Frame => ({ dir: 'in', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1, ...info } } })
    expect(differs(diff([limit({ utilization: 0.8, surpassedThreshold: 0.75 })], [limit({})]))).toBe(false)
    const gone: Frame = { dir: 'in', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } }
    expect(diff([limit({})], [gone]).read).toEqual([{ kind: 'in rate_limit_event', fields: ['rate_limit_info.resetsAt'] }])
  })
})

describe('what the canary asks to re-record', () => {
  const shape = (frames: Frame[]): Shape => shapeOf(frames, claude)

  it('nothing when no canary scenario differs', () => {
    const tools = new Map([['tools', shapeOf(recorded('2.1.296', 'tools'), claude)]])
    const same = new Map(CANARY.claude!.map((n) => [n, diffShapes(shapeOf(recorded('2.1.296', n), claude), shapeOf(recorded('2.1.296', n), claude), { rules: claude, scenario: n })]))
    expect(toRerecord(same, tools)).toEqual([])
  })

  it('the scenario that differs, and every earlier scenario whose frames hold a kind that lost a field or changed a type, not the others', () => {
    const changed: Frame = { dir: 'in', msg: { type: 'result', subtype: 'success', cost: 1 } }
    const diffs = new Map([
      ['basic', diffShapes(shape([text('a', 'a'), result(0.001)]), shape([text('a', 'a'), changed]), { rules: claude })],
      ['thinking', diffShapes(shape([stop('end_turn')]), shape([stop('refusal')]), { rules: claude })],
    ])
    const earlier = new Map([
      ['tools', shape([result(0.001)])],
      ['plan', shape([{ dir: 'out', msg: { type: 'control_request', request: { subtype: 'interrupt' } } }])],
      ['web', shape([stop('end_turn')])],
    ])
    // A new stop reason is the thinking scenario's own: the other recordings with a message_delta still hold
    expect(toRerecord(diffs, earlier)).toEqual(['basic', 'thinking', 'tools'])
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
    const folder = recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === 'claude-code-2.1.316')
    expect(folder?.names).toEqual(expect.arrayContaining([...CANARY.claude!]))
  })

  it('bring every kind the Claude adapter branches on that a short run can, background tasks, compaction and an app server among them', () => {
    const kinds = new Set(CANARY.claude!.flatMap((n) => [...shapeOf(recorded('2.1.316', n)).kinds.keys()]))
    for (const k of ['in system:task_started', 'in system:task_notification', 'in system:task_updated', 'in system:background_tasks_changed', 'in system:compact_boundary', 'in control_request:mcp_message', 'in control_request:can_use_tool', 'out control_request:interrupt', 'in assistant:thinking'])
      expect(kinds, k).toContain(k)
  })

  it('read the same on 2.1.296 and 2.1.316, one by one', () => {
    const earlier = new Map(recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === 'claude-code-2.1.296')!.names.map((n) => [n, shapeOf(recorded('2.1.296', n), claude)]))
    const now = new Map(CANARY.claude!.map((n) => [n, shapeOf(recorded('2.1.316', n), claude)]))
    for (const [n, d] of compareVersions(earlier, now, { rules: claude, unread: unreadKinds('claude', CLAUDE_LIMITATIONS) })) expect(d, n).toMatchObject({ gone: [], added: [], fields: expect.anything(), read: [], types: [], values: [], order: [] })
    expect(toRerecord(compareVersions(earlier, now, { rules: claude, unread: unreadKinds('claude', CLAUDE_LIMITATIONS) }), earlier)).toEqual([])
    // And tell two scenarios apart
    expect(differs(diff(recorded('2.1.296', 'basic'), recorded('2.1.296', 'approval')))).toBe(true)
  })

  it('name in their rules only fields and kinds the recordings hold, so a misspelt or renamed entry shows', () => {
    const shapes = (dir: string) => recordedFolders(dir).flatMap((f) => f.names.map((n) => shapeOf(readFrames(`${dir}/${f.dir}/${n}.jsonl`))))
    for (const [tool, dir] of [['claude', CLAUDE_RECORDINGS], ['codex', CODEX_RECORDINGS]] as const) {
      const all = shapes(dir)
      const rules = RULES[tool]!
      for (const [key, fields] of [...Object.entries(rules.read), ...Object.entries(rules.enums)])
        for (const field of fields) expect(all.some((s) => [...s.kinds].some(([k, v]) => kindMatches(k, key) && v.fields.has(field))), `${tool} ${key} ${field}`).toBe(true)
      for (const key of [...Object.keys(rules.optional), ...rules.unordered, ...rules.stateful])
        expect(all.some((s) => [...s.kinds.keys()].some((k) => kindMatches(k, key))), `${tool} ${key}`).toBe(true)
    }
  })

  it("counts a run's cost from Claude Code's own running total, per process", () => {
    expect(costOf([result(0.001), result(0.003), { dir: 'exit', msg: {} }, result(0.002)])).toBeCloseTo(0.005)
    expect(costOf([text('a', 'a')])).toBeNull()
    expect(costOf(recorded('2.1.296', 'basic'))).toBeGreaterThan(0)
  })
})
