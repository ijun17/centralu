#!/usr/bin/env -S npx tsx
/**
 * The recordings' canary (#1498 step 3, owner decision 2026-11-09): a new CLI version is not re-recorded whole. A few
 * representative scenarios are recorded on it, compared one by one with the same scenario on the newest version recorded
 * before, and only where they differ is more re-recorded. This script decides that, not an agent's judgement:
 *
 *   pnpm frames:canary <claude | codex> [--compare-only]
 *
 * - The installed CLI's version (as the host reads it) names its folder, `adapters/<tool>/recordings/<tool>-<version>/`.
 *   The canary scenarios that folder lacks are recorded there by `scripts/frames-record.mts` (it spends model calls on
 *   the cheapest model; `--compare-only` records nothing and compares what is there).
 * - Each canary scenario is compared with itself on the newest earlier version that has them all, by what the adapter
 *   depends on and a run does not choose: the kinds of frame, their fields, the fields the adapter reads, their JSON
 *   types, the values of the fields it tells apart, and the order of the kinds sent once in a turn (`diffShapes`). Never
 *   the frames' text, ids or timing, so two runs that differ only in what the model said read the same.
 * - No difference: it says the earlier version's recordings still hold, exit 0. A difference: it prints it per scenario
 *   and names the scenarios to re-record (`toRerecord`), exit 1. New fields are printed, not counted.
 * - Either way, the new recordings stay: the replay tests run every version's folder.
 *
 * What a canary run cost is read from the recordings it made (Claude Code's `total_cost_usd`); Codex's frames carry none.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPTERS = join(ROOT, 'packages/agent-host/src/adapters')

/**
 * The scenarios a canary records, per tool: few and cheap (a whole canary run on Claude Code costs about two cents on the
 * cheapest model), and between them every kind of frame a session lives on and every kind the adapter branches on that a short
 * run brings: a plain turn, a tool call the person approves, the model's thinking or reasoning, an interrupt, a background
 * agent (`system:task_*`, `system:background_tasks_changed`), a compaction (`system:compact_boundary`) and an app's MCP server
 * in the host (`control_request:mcp_message`). docs/agent-host/adapters/adding-a-tool.md says what no canary scenario brings
 */
export const CANARY: Record<string, readonly string[]> = {
  claude: ['basic', 'approval', 'thinking', 'interrupt', 'background-agent', 'compact', 'mcp-app'],
  // Codex shows its reasoning in every turn: `basic` carries it. An MCP tool call stands in for the thinking scenario
  codex: ['basic', 'approval', 'interrupt', 'mcp-call'],
}

/**
 * What the canary knows of a tool's frames beyond their shape, per kind (as `frameKind` names it; a key ending in `*` names
 * every kind it begins):
 *
 * - `read`: fields the adapter reads. Missing from every frame of a kind when an earlier frame of it had one, it counts, though
 *   not every earlier frame had it (`user_message_uuid` only on the message that starts a turn, `is_error` not on every result).
 * - `enums`: fields whose values the adapter tells apart; a value the earlier recording of the scenario never had counts.
 * - `optional`: kinds a run sends or not whatever the version, as the model or a timer chooses: gone from a scenario, they
 *   count only in the scenarios listed with them (the thinking scenario's thinking).
 * - `unordered`: kinds whose place in a turn is a timer's or the CLI's housekeeping, left out of the order.
 * - `stateful`: kinds whose fields follow the account's state (how near a limit it is), so a field gone from them is no change
 *   unless the adapter reads it.
 *
 * Kept by hand, as what the adapter reads is code, not data. The canary's test checks that every field named here is one the
 * recordings hold, so a misspelt or renamed entry does not pass unnoticed
 */
export type Rules = {
  read: Readonly<Record<string, readonly string[]>>
  enums: Readonly<Record<string, readonly string[]>>
  optional: Readonly<Record<string, readonly string[]>>
  unordered: readonly string[]
  stateful: readonly string[]
}

const THINKING = ['thinking']
export const RULES: Record<string, Rules> = {
  claude: {
    read: {
      'in system:init': ['session_id', 'model', 'tools', 'mcp_servers', 'slash_commands', 'claude_code_version', 'capabilities'],
      'in assistant:*': ['message.id', 'message.model', 'message.usage', 'message.content[].type', 'message.content[].text', 'message.content[].thinking', 'message.content[].id', 'message.content[].name', 'message.content[].input', 'parent_tool_use_id'],
      'in user:tool_result': ['message.content[].tool_use_id', 'message.content[].content', 'message.content[].is_error', 'tool_use_result', 'parent_tool_use_id'],
      'in stream_event:*': ['event.type', 'parent_tool_use_id'],
      'in stream_event:message_start': ['event.message.id', 'user_message_uuid', 'user_message_uuids'],
      'in stream_event:message_delta': ['event.delta.stop_reason', 'event.usage.output_tokens'],
      'in stream_event:content_block_start/tool_use': ['event.content_block.id', 'event.content_block.name'],
      'in stream_event:content_block_delta/text_delta': ['event.delta.text'],
      'in stream_event:content_block_delta/thinking_delta': ['event.delta.thinking'],
      'in stream_event:content_block_delta/input_json_delta': ['event.delta.partial_json'],
      'in result:*': ['is_error', 'result', 'usage', 'total_cost_usd', 'modelUsage', 'permission_denials', 'user_message_uuid', 'user_message_uuids'],
      'in control_request:can_use_tool': ['request_id', 'request.tool_name', 'request.input', 'request.tool_use_id', 'request.permission_suggestions'],
      'in control_request:mcp_message': ['request_id', 'request.server_name', 'request.message', 'request.message.method', 'request.message.id'],
      'in system:status': ['status', 'user_message_uuids'],
      'in system:task_started': ['task_id', 'tool_use_id', 'task_type', 'description'],
      'in system:task_updated': ['task_id', 'patch', 'patch.status'],
      'in system:task_notification': ['task_id', 'tool_use_id', 'status', 'summary', 'usage.tool_uses', 'usage.duration_ms'],
      'in system:background_tasks_changed': ['tasks', 'tasks[].task_id', 'tasks[].task_type', 'tasks[].description'],
      'in system:compact_boundary': ['compact_metadata.trigger', 'compact_metadata.pre_tokens', 'compact_metadata.post_tokens'],
      'in rate_limit_event': ['rate_limit_info', 'rate_limit_info.status', 'rate_limit_info.resetsAt', 'rate_limit_info.rateLimitType'],
    },
    enums: {
      'in assistant:*': ['message.stop_reason'],
      'in stream_event:message_delta': ['event.delta.stop_reason'],
      'in result:*': ['stop_reason', 'terminal_reason'],
      'in control_request:can_use_tool': ['request.permission_suggestions[].type', 'request.permission_suggestions[].behavior', 'request.permission_suggestions[].destination'],
      'out control_response:success': ['response.response.behavior'],
      'in system:init': ['permissionMode'],
      'in system:status': ['status'],
      'in system:task_started': ['task_type'],
      'in system:task_updated': ['patch.status'],
      'in system:task_notification': ['status'],
      'in system:background_tasks_changed': ['tasks[].task_type'],
      'in system:compact_boundary': ['compact_metadata.trigger'],
    },
    optional: {
      // Whether the model thinks, and whether it says something, before an answer or a call is its choice on that run
      'in assistant:thinking': THINKING,
      'in stream_event:content_block_start/thinking': THINKING,
      'in stream_event:content_block_delta/thinking_delta': THINKING,
      'in stream_event:content_block_delta/signature_delta': THINKING,
      'in system:thinking_tokens': THINKING,
      'in assistant:text': [],
      'in stream_event:content_block_start/text': [],
      'in stream_event:content_block_delta/text_delta': [],
      // A timer's or the account's
      'in rate_limit_event': [],
      'out control_request:get_context_usage': [],
      'in command_lifecycle': [],
    },
    unordered: ['in rate_limit_event', 'out control_request:get_context_usage', 'in control_response:success', 'in command_lifecycle', 'in system:commands_changed', 'in system:thinking_tokens', 'exit'],
    stateful: ['in rate_limit_event'],
  },
  codex: {
    read: {
      'in item/started:*': ['params.item.id', 'params.item.type', 'params.turnId'],
      'in item/completed:*': ['params.item.id', 'params.item.type', 'params.turnId'],
      'in item/completed:agentMessage': ['params.item.text'],
      'in item/completed:commandExecution': ['params.item.command', 'params.item.aggregatedOutput', 'params.item.exitCode', 'params.item.status'],
      'in item/completed:mcpToolCall': ['params.item.server', 'params.item.tool', 'params.item.status', 'params.item.result'],
      'in item/agentMessage/delta': ['params.itemId', 'params.delta'],
      'in item/commandExecution/requestApproval': ['id', 'params.itemId', 'params.command', 'params.turnId'],
      'in turn/completed': ['params.turn.id', 'params.turn.status', 'params.turn.error'],
      'in thread/tokenUsage/updated': ['params.tokenUsage.total', 'params.tokenUsage.last'],
      'in result:thread/start': ['result.thread.id'],
    },
    enums: {
      'in item/started:*': ['params.item.type', 'params.item.status'],
      'in item/completed:*': ['params.item.type', 'params.item.status'],
      'in turn/completed': ['params.turn.status'],
      'in thread/status/changed': ['params.status.type'],
      'out result:item/commandExecution/requestApproval': ['result.decision'],
    },
    optional: {
      'in account/rateLimits/updated': [],
      'in account/updated': [],
      'in remoteControl/status/changed': [],
      'in mcpServer/startupStatus/updated': [],
    },
    unordered: ['in account/rateLimits/updated', 'in account/updated', 'in remoteControl/status/changed', 'in mcpServer/startupStatus/updated', 'in thread/tokenUsage/updated', 'in thread/status/changed', 'exit'],
    stateful: ['in account/rateLimits/updated', 'in account/updated'],
  },
}

/** No knowledge beyond the shape: what a comparison without a tool's rules uses */
export const NO_RULES: Rules = { read: {}, enums: {}, optional: {}, unordered: ['exit'], stateful: [] }

/** Whether a rule's key names a kind: exactly, or by the beginning before its `*` */
export const kindMatches = (kind: string, key: string) => (key.endsWith('*') ? kind.startsWith(key.slice(0, -1)) : kind === key)
const ruleFor = (table: Readonly<Record<string, readonly string[]>>, kind: string) => Object.entries(table).flatMap(([k, v]) => (kindMatches(kind, k) ? v : []))

/** The recordings folder of each tool, and the prefix of its version folders */
const FOLDERS: Record<string, { dir: string; prefix: string }> = {
  claude: { dir: join(ADAPTERS, 'claude', 'recordings'), prefix: 'claude-code-' },
  codex: { dir: join(ADAPTERS, 'codex', 'recordings'), prefix: 'codex-' },
}

/** One recorded line: which way it went (`in` from the tool, `out` to it, `exit`), and the message */
export type Frame = { dir: string; msg?: unknown }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A JSON-RPC message (Codex's app-server), as against a stream-json line (Claude Code) */
const isRpc = (m: Obj) => 'jsonrpc' in m || (typeof m.method === 'string' && !('type' in m)) || ('id' in m && ('result' in m || 'error' in m) && !('type' in m))

/** The kinds of a content list (`text`, `tool_use`, …), in order, without repeats */
const contentKinds = (content: unknown): string => (Array.isArray(content) ? [...new Set(content.map((c) => (isObj(c) ? str(c.type) : typeof c)))].join('+') : typeof content)

/**
 * What kind of frame this is, as a word that does not depend on values a run chooses (ids, text, times): the message's type
 * and subtype, a stream event's type and its delta's, a message's content kinds, a JSON-RPC method (an answer: the method it
 * answers, which `methods` remembers by id)
 */
export function frameKind(f: Frame, methods: Map<string, string> = new Map()): string {
  if (f.dir === 'exit') return 'exit'
  const m = f.msg
  if (!isObj(m)) return `${f.dir} ${typeof m}`
  if (isRpc(m)) {
    const id = m.id === undefined ? null : `${f.dir === 'in' ? 'out' : 'in'}:${String(m.id)}`
    if (typeof m.method === 'string') {
      if (m.id !== undefined) methods.set(`${f.dir}:${String(m.id)}`, m.method)
      const p = isObj(m.params) ? m.params : {}
      const item = isObj(p.item) ? str(p.item.type) : isObj(p.msg) ? str(p.msg.type) : ''
      return `${f.dir} ${m.method}${item ? `:${item}` : ''}`
    }
    const asked = id ? methods.get(id) : undefined
    return `${f.dir} ${'error' in m ? 'error' : 'result'}${asked ? `:${asked}` : ''}`
  }
  const type = str(m.type)
  if (type === 'control_request') return `${f.dir} control_request:${isObj(m.request) ? str(m.request.subtype) : ''}`
  if (type === 'control_response') return `${f.dir} control_response:${isObj(m.response) ? str(m.response.subtype) : ''}`
  if (type === 'stream_event' && isObj(m.event)) {
    const e = m.event
    const sub = isObj(e.delta) ? str(e.delta.type) : isObj(e.content_block) ? str(e.content_block.type) : ''
    return `${f.dir} stream_event:${str(e.type)}${sub ? `/${sub}` : ''}`
  }
  if ((type === 'assistant' || type === 'user') && isObj(m.message)) return `${f.dir} ${type}:${contentKinds(m.message.content)}`
  return `${f.dir} ${type}${typeof m.subtype === 'string' ? `:${m.subtype}` : ''}`
}

/**
 * A key that is data rather than a name: an id (`toolu_01Qj…`, a uuid), a path, a number, a model's or a server's name used
 * as a key (`claude-haiku-5-5`)
 */
const dataKey = (k: string) =>
  k.length > 40 || /^\d+$/.test(k) || /[/\\.:\s@]/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[a-z]+_[A-Za-z0-9]{16,}$/.test(k) || /-\d/.test(k)


/** A field's JSON type, as the comparison tells them apart */
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** Every field of a message, as its path (`message.content[].type`) and value; keys that are data read `*` */
function walk(v: unknown, at: string, visit: (path: string, value: unknown) => void, depth = 0, filled?: (path: string) => void): void {
  if (depth > 8) return
  if (Array.isArray(v)) {
    if (v.length) filled?.(`${at}[]`)
    for (const x of v) walk(x, `${at}[]`, visit, depth + 1, filled)
    return
  }
  if (!isObj(v)) return
  for (const [k, x] of Object.entries(v)) {
    const path = `${at ? `${at}.` : ''}${dataKey(k) ? '*' : k}`
    visit(path, x)
    walk(x, path, visit, depth + 1, filled)
  }
}

/** The field names a message holds, as paths (`message.content[].type`), never its values; keys that are data read `*` */
export function fieldPaths(v: unknown): Set<string> {
  const out = new Set<string>()
  walk(v, '', (p) => out.add(p))
  return out
}

/**
 * One kind of frame in a recording: how many frames of it there were, in how many of them each field name was, the JSON types
 * each field had, the values of the fields its rules name as `enums`, and the lists that had items in some frame (`a.b[]`)
 */
export type KindShape = { frames: number; fields: Map<string, number>; types: Map<string, Set<string>>; values: Map<string, Set<string>>; filled: Set<string> }

/**
 * A recording's shape: its kinds of frame, and per turn (from each prompt sent: Claude Code's `user` line, Codex's
 * `turn/start`) the kinds in the order they came
 */
export type Shape = { kinds: Map<string, KindShape>; turns: string[][] }

const TURN_START = ['out user:*', 'out turn/start']

export function shapeOf(frames: readonly Frame[], rules: Rules = NO_RULES): Shape {
  const methods = new Map<string, string>()
  const kinds = new Map<string, KindShape>()
  const turns: string[][] = [[]]
  for (const f of frames) {
    const kind = frameKind(f, methods)
    if (TURN_START.some((k) => kindMatches(kind, k))) turns.push([])
    turns.at(-1)!.push(kind)
    const k = kinds.get(kind) ?? { frames: 0, fields: new Map<string, number>(), types: new Map<string, Set<string>>(), values: new Map<string, Set<string>>(), filled: new Set<string>() }
    k.frames++
    const enums = new Set(ruleFor(rules.enums, kind))
    const held = new Set<string>()
    walk(f.msg, '', (p, v) => {
      held.add(p)
      k.types.set(p, (k.types.get(p) ?? new Set()).add(typeOf(v)))
      if (enums.has(p) && (v === null || typeof v !== 'object')) k.values.set(p, (k.values.get(p) ?? new Set()).add(String(v)))
    }, 0, (p) => k.filled.add(p))
    for (const p of held) k.fields.set(p, (k.fields.get(p) ?? 0) + 1)
    kinds.set(kind, k)
  }
  return { kinds, turns }
}

/** How a scenario's frames on a new version differ from its frames on the earlier one; every list empty when they do not */
export type ShapeDiff = {
  /** Kinds of frame the scenario sent only on the earlier version */
  gone: string[]
  /** Kinds of frame the scenario sent on the new version that no recording of the earlier version holds */
  added: string[]
  /**
   * Per kind both sent: the field names every frame of it held before and none holds now (`gone`), and the names only the new
   * version has (`added`, printed, not counted). A name only some frames held before is one a run may leave out, so its
   * absence alone is no change; nor are the fields of a list's items when no frame's list has items now (an empty
   * `mcp_servers`), nor a field of a kind that follows the account's state (`Rules.stateful`)
   */
  fields: { kind: string; gone: string[]; added: string[] }[]
  /** Per kind both sent: the fields the adapter reads (`Rules.read`) that some frame had before and none has now */
  read: { kind: string; fields: string[] }[]
  /**
   * Per field both versions sent: the JSON types it has now and never had before (a number that came as a string). Not
   * `null`, nor a field that was only ever `null` before: that is how the CLI says a value is not there on this run
   */
  types: { kind: string; field: string; before: string[]; now: string[] }[]
  /** Per field the adapter tells the values of (`Rules.enums`): the values it has now and never had before */
  values: { kind: string; field: string; added: string[] }[]
  /**
   * Per turn: the kinds sent once in it on both versions, where their order is not the same. Only those: a kind sent several
   * times (a text delta, a tool's call when the model made two) has no one place, and the order of the frames within a
   * message is the stream's. Timers' kinds (`Rules.unordered`) are left out
   */
  order: { turn: number; before: string[]; now: string[] }[]
}

/** The kinds sent exactly once in a turn, in their order, without the unordered ones */
function onceIn(turn: readonly string[], unordered: readonly string[]): string[] {
  const count = new Map<string, number>()
  for (const k of turn) count.set(k, (count.get(k) ?? 0) + 1)
  return turn.filter((k) => count.get(k) === 1 && !unordered.some((u) => kindMatches(k, u)))
}

/**
 * Compares one scenario's recording on the earlier version (`before`) with the same scenario on the new one (`now`).
 *
 * - `unread`: kinds whose absence changes nothing, as the adapter makes nothing of them (its surface's dropped messages).
 * - `known`: every kind the earlier version's recordings hold, of any scenario: one the model sent in another scenario then is
 *   no new kind (the replay tests of those recordings cover it). By default, `before`'s own kinds.
 * - `scenario`: its name, for the kinds that are optional but in some scenarios (`Rules.optional`).
 *
 * The process's exit is never counted: whether it lands before the recorder stops is the run's timing
 */
export function diffShapes(
  before: Shape,
  now: Shape,
  o: { rules?: Rules; unread?: ReadonlySet<string>; known?: ReadonlySet<string>; scenario?: string } = {},
): ShapeDiff {
  const rules = o.rules ?? NO_RULES
  const unread = o.unread ?? new Set<string>()
  const known = o.known ?? new Set(before.kinds.keys())
  const optional = (kind: string) => Object.entries(rules.optional).some(([k, except]) => kindMatches(kind, k) && !(o.scenario && except.includes(o.scenario)))
  const gone = [...before.kinds.keys()].filter((k) => !now.kinds.has(k) && k !== 'exit' && !unread.has(k) && !optional(k)).sort()
  const added = [...now.kinds.keys()].filter((k) => !before.kinds.has(k) && !known.has(k) && k !== 'exit').sort()
  const both = [...before.kinds.keys()].filter((k) => now.kinds.has(k)).sort()
  const fields: ShapeDiff['fields'] = []
  const read: ShapeDiff['read'] = []
  const types: ShapeDiff['types'] = []
  const values: ShapeDiff['values'] = []
  for (const kind of both) {
    const b = before.kinds.get(kind)!
    const n = now.kinds.get(kind)!
    // A field within a list's items is missing only where the list has items now
    const missing = (p: string) => !n.fields.has(p) && (!p.includes('[]') || n.filled.has(p.slice(0, p.lastIndexOf('[]') + 2)))
    const stateful = rules.stateful.some((s) => kindMatches(kind, s))
    const lost = stateful ? [] : [...b.fields].filter(([p, count]) => count === b.frames && missing(p)).map(([p]) => p).sort()
    const fresh = [...n.fields.keys()].filter((p) => !b.fields.has(p)).sort()
    if (lost.length || fresh.length) fields.push({ kind, gone: lost, added: fresh })
    const unseen = [...new Set(ruleFor(rules.read, kind))].filter((p) => b.fields.has(p) && missing(p) && !lost.includes(p)).sort()
    if (unseen.length) read.push({ kind, fields: unseen })
    for (const [field, t] of [...n.types].sort(([x], [y]) => x.localeCompare(y))) {
      const was = b.types.get(field)
      if (was && [...was].some((x) => x !== 'null') && [...t].some((x) => x !== 'null' && !was.has(x))) types.push({ kind, field, before: [...was].sort(), now: [...t].sort() })
    }
    for (const field of [...new Set(ruleFor(rules.enums, kind))].sort()) {
      const was = b.values.get(field) ?? new Set<string>()
      const more = [...(n.values.get(field) ?? [])].filter((v) => !was.has(v)).sort()
      if (more.length) values.push({ kind, field, added: more })
    }
  }
  const order: ShapeDiff['order'] = []
  for (let i = 0; i < Math.min(before.turns.length, now.turns.length); i++) {
    const a = onceIn(before.turns[i]!, rules.unordered)
    const c = onceIn(now.turns[i]!, rules.unordered)
    const x = a.filter((k) => c.includes(k))
    const y = c.filter((k) => a.includes(k))
    if (x.join('\n') !== y.join('\n')) order.push({ turn: i, before: x, now: y })
  }
  return { gone, added, fields, read, types, values, order }
}

/**
 * Whether the new version sends something the earlier recording of the scenario does not hold. A new field alone is not: the
 * adapter reads none it was not written for, and the replay tests say when one it was written for is missing
 */
export const differs = (d: ShapeDiff) =>
  d.gone.length > 0 || d.added.length > 0 || d.fields.some((f) => f.gone.length > 0) || d.read.length > 0 || d.types.length > 0 || d.values.length > 0 || d.order.length > 0

/**
 * Each canary scenario on the new version (`now`) compared with itself among the earlier version's recordings (`earlier`, all
 * of them: a kind any of them holds is known)
 */
export function compareVersions(earlier: ReadonlyMap<string, Shape>, now: ReadonlyMap<string, Shape>, o: { rules?: Rules; unread?: ReadonlySet<string> } = {}): Map<string, ShapeDiff> {
  const known = new Set([...earlier.values()].flatMap((s) => [...s.kinds.keys()]))
  return new Map([...now].map(([n, shape]) => [n, diffShapes(earlier.get(n) ?? { kinds: new Map(), turns: [] }, shape, { ...o, known, scenario: n })]))
}

/** What a scenario's difference is, a line each, for the person who runs the canary */
export function describeDiff(d: ShapeDiff): string[] {
  return [
    ...(d.gone.length ? [`kinds of frame gone: ${d.gone.join(', ')}`] : []),
    ...(d.added.length ? [`new kinds of frame: ${d.added.join(', ')}`] : []),
    ...d.fields.filter((f) => f.gone.length).map((f) => `${f.kind}: fields every frame had, gone: ${f.gone.join(', ')}`),
    ...d.read.map((r) => `${r.kind}: fields the adapter reads, gone: ${r.fields.join(', ')}`),
    ...d.types.map((t) => `${t.kind}: ${t.field} was ${t.before.join(' | ')}, now ${t.now.join(' | ')}`),
    ...d.values.map((v) => `${v.kind}: ${v.field} has new values: ${v.added.join(', ')}`),
    ...d.order.map((o) => `turn ${o.turn}: the order was ${o.before.join(' > ')}, now ${o.now.join(' > ')}`),
  ]
}

/**
 * The scenarios to re-record on the new version: every canary scenario that differs, and every scenario recorded on the earlier
 * version whose frames hold a kind that is gone, lost a field or changed a field's type in one of them (a new value or another
 * order is the scenario's own, and a new kind is in the scenario that showed it)
 */
export function toRerecord(diffs: ReadonlyMap<string, ShapeDiff>, earlier: ReadonlyMap<string, Shape>): string[] {
  const names = new Set<string>()
  const changed = new Set<string>()
  for (const [name, d] of diffs) {
    if (!differs(d)) continue
    names.add(name)
    for (const k of [...d.gone, ...d.fields.filter((f) => f.gone.length).map((f) => f.kind), ...d.read.map((r) => r.kind), ...d.types.map((t) => t.kind)]) changed.add(k)
  }
  for (const [name, shape] of earlier) if ([...shape.kinds.keys()].some((k) => changed.has(k))) names.add(name)
  return [...names].sort()
}

/** What a recording's run cost, from Claude Code's `total_cost_usd` (cumulative within a process): null when its frames carry none */
export function costOf(frames: readonly Frame[]): number | null {
  let total = 0
  let process = 0
  let seen = false
  for (const f of frames) {
    if (f.dir === 'exit') {
      total += process
      process = 0
      continue
    }
    const m = f.msg
    if (isObj(m) && m.type === 'result' && typeof m.total_cost_usd === 'number') {
      process = Math.max(process, m.total_cost_usd)
      seen = true
    }
  }
  return seen ? total + process : null
}

/** The frames of a recording file (its header line left out) */
export function readFrames(file: string): Frame[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Frame & { header?: unknown })
    .filter((l) => !('header' in l))
}

const versionOf = (name: string, prefix: string) => name.slice(prefix.length)
const semver = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
/** Newest first */
const byVersion = (a: string, b: string) => {
  const x = semver(a)
  const y = semver(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? -1
    const q = y[i] ?? -1
    if (p !== q) return typeof p === 'number' && typeof q === 'number' ? q - p : String(q).localeCompare(String(p))
  }
  return 0
}

/** The newest version other than `version` whose folder holds every scenario of `names` */
export function earlierVersion(versions: readonly string[], version: string, has: (v: string) => boolean): string | null {
  return [...versions].filter((v) => v !== version && byVersion(v, version) > 0 && has(v)).sort(byVersion)[0] ?? null
}

/** The kinds of frame an adapter drops on purpose (its surface's `dropped` messages), as `frameKind` names them */
export function unreadKinds(tool: string, limitations: readonly { kind: string; name: string; treatment: string }[]): Set<string> {
  const dropped = limitations.filter((l) => l.kind === 'message' && l.treatment === 'dropped').map((l) => l.name)
  return new Set(dropped.map((n) => (tool === 'claude' ? `in ${n.replace('/', ':')}` : `in ${n}`)))
}

async function limitationsOf(tool: string) {
  if (tool === 'claude') return (await import('../packages/agent-host/src/adapters/claude/surface.js')).CLAUDE_LIMITATIONS
  return (await import('../packages/agent-host/src/adapters/codex/surface.js')).CODEX_LIMITATIONS
}

async function installedVersion(tool: string): Promise<string | null> {
  if (tool === 'claude') {
    const { ClaudeAdapter } = await import('../packages/agent-host/src/adapters/claude/index.js')
    return (await new ClaudeAdapter().installedVersion()) ?? null
  }
  const { CodexAdapter } = await import('../packages/agent-host/src/adapters/codex/index.js')
  const v = await new CodexAdapter().installedVersion?.()
  return v ? v.replace(/^codex-cli /, '').split(/[-\s]/)[0]! : null
}


async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const compareOnly = args.includes('--compare-only')
  const tool = args.find((a) => !a.startsWith('--'))
  if (!tool || !CANARY[tool]) {
    console.error('usage: pnpm frames:canary <claude | codex> [--compare-only]')
    return 2
  }
  const { dir, prefix } = FOLDERS[tool]!
  const names = CANARY[tool]!
  const rules = RULES[tool] ?? NO_RULES
  const version = await installedVersion(tool)
  if (!version) {
    console.error(`[canary] no installed ${tool} found (the host's own lookup)`)
    return 2
  }
  const folder = (v: string) => join(dir, `${prefix}${v}`)
  const file = (v: string, name: string) => join(folder(v), `${name}.jsonl`)
  const versions = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => versionOf(n, prefix)) : []
  const before = earlierVersion(versions, version, (v) => names.every((n) => existsSync(file(v, n))))
  if (!before) {
    console.error(`[canary] no ${tool} version before ${version} has every canary scenario (${names.join(', ')}): nothing to compare with; record them all`)
    return 2
  }
  console.log(`[canary] ${tool} ${version} installed; compared with ${before}, the newest recorded before it`)

  const missing = names.filter((n) => !existsSync(file(version, n)))
  let cost: number | null = null
  if (missing.length && compareOnly) {
    console.error(`[canary] ${version} has no recording of ${missing.join(', ')}, and --compare-only records nothing`)
    return 2
  }
  if (missing.length) {
    console.log(`[canary] recording ${missing.join(', ')} on ${version} (model calls on the cheapest model)`)
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/frames-record.mts'), tool, ...missing], { cwd: ROOT, stdio: 'inherit' })
    const made = missing.filter((n) => existsSync(file(version, n)))
    if (r.status !== 0 || made.length < missing.length) {
      console.error(`[canary] the recording did not finish (exit ${r.status}); recorded: ${made.join(', ') || 'none'}`)
      return 2
    }
    const costs = made.map((n) => costOf(readFrames(file(version, n))))
    cost = costs.every((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0)
  }

  // Every recording of the earlier version: what to re-record is chosen among them, and a kind any of them holds is known
  const earlier = new Map<string, Shape>()
  for (const n of readdirSync(folder(before)).filter((n) => n.endsWith('.jsonl'))) earlier.set(n.replace(/\.jsonl$/, ''), shapeOf(readFrames(join(folder(before), n)), rules))
  const now = new Map(names.map((n) => [n, shapeOf(readFrames(file(version, n)), rules)]))
  const diffs = compareVersions(earlier, now, { rules, unread: unreadKinds(tool, await limitationsOf(tool)) })

  for (const [n, d] of diffs) {
    const lines = describeDiff(d)
    console.log(`  ${n}: ${lines.length ? '' : 'the same'}${lines.map((l) => `\n    ${l}`).join('')}`)
    const news = d.fields.filter((f) => f.added.length)
    if (news.length) console.log(`    new fields (no reason to re-record alone): ${news.map((f) => `${f.kind}: ${f.added.join(', ')}`).join('; ')}`)
  }
  if (cost !== null) console.log(`[canary] this run's recordings cost $${cost.toFixed(4)} (the tool's own count)`)
  const again = toRerecord(diffs, earlier)
  if (!again.length) {
    console.log(`[canary] no difference: ${before}'s recordings still hold for ${version}`)
    return 0
  }
  console.log(`[canary] re-record on ${version}: ${again.join(' ')}`)
  console.log(`  pnpm exec tsx scripts/frames-record.mts ${tool} ${again.join(' ')}`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main())
