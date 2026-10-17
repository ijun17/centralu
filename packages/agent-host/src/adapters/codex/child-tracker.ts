import { asObj, str } from '../../json-value.js'
import { type BackgroundTask, type NormalizedEvent } from '@cc/protocol'
import { subagentSteps } from '../subagent-steps.js'
import { firstLine } from '../tool-titles.js'
import { codexItemOk } from './items.js'
import { messageIdOf, normalizeNotification, type Notification } from './normalize.js'

/**
 * A child thread's notification, as steps of the subagent a `spawnAgent` call launched (#222).
 *
 * Measured live (scripts/probe-codex-subagent.mts, codex-cli 0.160.0 and 0.153.4 in #222): the child's
 * `item/started` and `item/completed` arrive on the parent's connection with the child's `threadId`, for its prompt
 * (`userMessage`), its reasoning, its commands and its `agentMessage`. Steps are read from them alone:
 *
 *   - text and reasoning from the **completed** item (`text`, `summary`), whole. The child's deltas are not read:
 *     a step is one row (see `SubagentStep`), and the completed item carries the same text again
 *   - a tool call when its item starts, its result when it completes, exactly as the parent's own (`input` and
 *     `output` included, #221)
 *   - its prompt is not a step: it is the launch call's own `prompt`, already on the parent's card
 *
 * A file a child changed is still a file changed in this session's folder, so `files_touched` goes out as the
 * parent's, as Claude's subagents do (#98). Everything else a child sends (its turn and status, usage, images) is
 * not part of its record here.
 */
export function childSteps(sessionId: string, parentCallId: string, n: Notification): NormalizedEvent[] {
  if (n.method !== 'item/started' && n.method !== 'item/completed') return []
  const item = asObj(asObj(n.params).item)
  const type = str(item.type)
  if (type === 'agentMessage') {
    const text = n.method === 'item/completed' ? str(item.text) : ''
    return text ? subagentSteps(sessionId, parentCallId, [{ type: 'message_delta', sessionId, role: 'assistant', text, ...messageIdOf(item.id) }]) : []
  }
  if (type === 'reasoning') {
    const parts = n.method === 'item/completed' && Array.isArray(item.summary) ? item.summary.map((x) => str(x)).filter(Boolean) : []
    return parts.length ? subagentSteps(sessionId, parentCallId, [{ type: 'reasoning_delta', sessionId, text: parts.join('\n\n') }]) : []
  }
  // The rest as the parent's own items are read: calls and results, and the files they changed (adapters/subagent-steps.ts)
  return subagentSteps(sessionId, parentCallId, normalizeNotification(sessionId, n))
}

/** The child threads a completed `spawnAgent` call started (`receiverThreadIds`), none for any other item (#222, #843) */
export function launchedThreads(n: Notification): string[] {
  if (n.method !== 'item/completed') return []
  const item = asObj(asObj(n.params).item)
  if (str(item.type) !== 'collabAgentToolCall' || str(item.tool) !== 'spawnAgent' || !codexItemOk(item)) return []
  return (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter((t): t is string => typeof t === 'string' && t !== '')
}

/**
 * A Codex session's background work: its child agents (#290).
 *
 * A child runs on its own thread, and its notifications arrive on the parent's connection (#222). It is live while
 * its thread is active. Measured (scripts/probe-codex-background.mts, codex-cli 0.160.0, gpt-5.6-luna, 2026-10-04):
 *
 *   - the child's `thread/status/changed {active}` and `turn/started` arrive in the same millisecond as the parent's
 *     `spawnAgent` `item/completed` that names it, and sometimes before it — so a thread's state is kept from its
 *     first notification, and it is listed once a launch call names it (the same link #222 keys its steps by)
 *   - it ends with `{idle}` and `turn/completed`, in either order within a millisecond; the turn's `status`
 *     (`completed`, `interrupted`, `failed`) is how it ended. `{systemError}` is a failure
 *   - **interrupting the parent's turn does not stop it** (it went on reasoning, still active 20 s later), so every
 *     child says `stopsWithTurn: false`
 *   - `turn/interrupt` on the child's own turn stops it (`turn/completed {interrupted}`), which is the per-task stop.
 *     It needs the child's turn id, so a child is stoppable only while one is known
 *
 * Nested children (a child's own `spawnAgent`) are linked the same way and listed alongside. A child that started
 * before this process (a resumed thread's) is never named by a launch call here, so it is not listed.
 */
export class CodexChildTracker {
  private readonly threads = new Map<string, { active: boolean; turnId: string | null }>()
  /** Linked children: thread to its launch call and description. Only these are listed. */
  private readonly linked = new Map<string, { callId: string; description: string }>()
  private lastLive = '[]'
  /**
   * Launch cards held open while the children they started run (#843). A `spawnAgent` item completes the moment the
   * child starts (measured: its `item/completed` names the child's thread before the child has done anything), so its
   * card closed at once, and the screen, which draws live output only on an open card, never showed the child's steps
   * (`childSteps`). The result is held until every child it named ends, as a Claude background agent's card stays open
   * until its `task_notification`.
   */
  private readonly held = new Map<string, { result: NormalizedEvent; threads: Set<string> }>()
  /** Children whose turn already ended, so a launch result arriving after that is not held (the latest few) */
  private done: string[] = []

  constructor(private readonly sessionId: string) {}

  /** A launch call's result, held while the children it started run; false when it goes out now (none still runs) */
  hold(result: Extract<NormalizedEvent, { type: 'tool_result' }>, threads: readonly string[]): boolean {
    const running = threads.filter((t) => !this.done.includes(t))
    if (running.length === 0) return false
    this.held.set(result.callId, { result, threads: new Set(running) })
    return true
  }

  /** A child's turn ended: the launch results that waited only on it go out */
  private finished(thread: string): NormalizedEvent[] {
    this.done = [...this.done.slice(-63), thread]
    const out: NormalizedEvent[] = []
    for (const [callId, h] of this.held) {
      if (!h.threads.delete(thread) || h.threads.size > 0) continue
      this.held.delete(callId)
      out.push(h.result)
    }
    return out
  }

  /** A `spawnAgent` call named this thread. */
  link(thread: string, callId: string, prompt: string): NormalizedEvent[] {
    if (this.linked.has(thread)) return []
    this.linked.set(thread, { callId, description: firstLine(prompt.trim()) || 'Child agent' })
    return this.changed()
  }

  /** A notification from a thread that is not the parent's. */
  push(thread: string, n: Notification): NormalizedEvent[] {
    const p = asObj(n.params)
    const t = this.threads.get(thread) ?? { active: false, turnId: null }
    this.threads.set(thread, t)
    if (n.method === 'thread/status/changed') {
      const type = str(asObj(p.status).type)
      if (type === 'active') t.active = true
      else if (type === 'systemError') {
        const was = t.active
        t.active = false
        t.turnId = null
        return [...(was ? this.changed([this.ended(thread, 'failed', 'The child thread hit a system error')]) : []), ...this.finished(thread)]
      } else t.active = false
      return this.changed()
    }
    if (n.method === 'turn/started') {
      t.active = true
      t.turnId = str(asObj(p.turn).id) || t.turnId
      return this.changed()
    }
    if (n.method === 'turn/completed') {
      const raw = str(asObj(p.turn).status)
      t.active = false
      t.turnId = null
      const status = raw === 'interrupted' ? 'stopped' : raw === 'failed' ? 'failed' : 'completed'
      const message = str(asObj(asObj(p.turn).error).message)
      return [...this.changed([this.ended(thread, status, message || undefined)]), ...this.finished(thread)]
    }
    return []
  }

  /** The turn to interrupt to stop this child, if one is running. */
  turnOf(thread: string): string | null {
    return this.threads.get(thread)?.turnId ?? null
  }

  /** The app-server went away and its child threads with it. */
  release(why: string): NormalizedEvent[] {
    const live = this.live()
    for (const t of this.threads.values()) {
      t.active = false
      t.turnId = null
    }
    // A launch card still held open closes with the reason, as a Claude agent that never reported back does
    const held: NormalizedEvent[] = [...this.held.keys()].map((callId) => ({ type: 'tool_result', sessionId: this.sessionId, callId, ok: false, summary: why }))
    this.held.clear()
    if (live.length === 0) return held
    return [...this.changed(live.map((task) => ({ ...task, status: 'stopped' as const, summary: why }))), ...held]
  }

  private ended(thread: string, status: 'completed' | 'failed' | 'stopped', summary?: string): BackgroundTask | null {
    const task = this.task(thread)
    return task ? { ...task, status, ...(summary ? { summary } : {}) } : null
  }

  private task(thread: string): BackgroundTask | null {
    const link = this.linked.get(thread)
    if (!link) return null
    const t = this.threads.get(thread)
    return {
      id: thread,
      kind: 'agent',
      description: link.description,
      parentCallId: link.callId,
      stopsWithTurn: false,
      stoppable: !!t?.turnId,
      status: 'running',
    }
  }

  private live(): BackgroundTask[] {
    const out: BackgroundTask[] = []
    for (const [thread, t] of this.threads) {
      const task = t.active ? this.task(thread) : null
      if (task) out.push(task)
    }
    return out
  }

  /** The event when the live set or an ending moved; nothing when neither did. */
  private changed(ended: (BackgroundTask | null)[] = []): NormalizedEvent[] {
    const live = this.live()
    const done = ended.filter((t): t is BackgroundTask => t !== null)
    const key = JSON.stringify(live)
    if (key === this.lastLive && done.length === 0) return []
    this.lastLive = key
    return [{ type: 'background_tasks', sessionId: this.sessionId, live, ...(done.length ? { ended: done } : {}) }]
  }
}
