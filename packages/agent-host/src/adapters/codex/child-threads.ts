import type { EventSink } from '../contract.js'
import { childSteps, CodexChildTracker } from './normalize.js'

/**
 * How many child items wait for their launch call at most (#222, `unlinked`). The wait is milliseconds long (measured:
 * the link came in the same millisecond as the child's first notification), so this only bounds a thread that is
 * never named.
 */
const UNLINKED_CAP = 2_000

/**
 * A Codex session's child threads (#222, #290): which `spawnAgent` card launched each, the steps they send under it,
 * what arrived before the card named its thread, and the background list of them (`CodexChildTracker`).
 */
export class CodexChildThreads {
  /**
   * Child threads (#222): a child's thread id, to the `spawnAgent` item that launched it. Its steps are kept under
   * that card. Learned from the item's `receiverThreadIds` on `item/completed` (the `item/started` has an empty list).
   */
  private childCalls = new Map<string, string>()
  /**
   * A child's items that arrived before its launch call named it. The child starts before the parent's `spawnAgent`
   * completes: measured (codex-cli 0.160.0), the child's first `thread/status/changed` came in the same millisecond
   * as, and before, the `item/completed` that names it. Held, not dropped, and replayed once the link arrives. What is
   * still unlinked when the parent's turn ends belonged to no launch call this session saw (one from before a restart),
   * and is let go with a log line.
   */
  private unlinked = new Map<string, { method: string; params?: unknown }[]>()
  private unlinkedCount = 0
  /** The child agents running in the background (#290, see `CodexChildTracker`). */
  readonly children: CodexChildTracker

  constructor(private readonly host: { readonly sessionId: string; emit: EventSink }) {
    this.children = new CodexChildTracker(host.sessionId)
  }

  /**
   * A child thread's notification (#222): its items become steps under the `spawnAgent` card that launched it, or wait
   * for that card to name the thread (`unlinked`). Only items are kept — the child's turn, status and deltas carry
   * nothing `childSteps` reads.
   */
  onChildNotification(thread: string, n: { method: string; params?: unknown }): void {
    if (n.method !== 'item/started' && n.method !== 'item/completed') return
    const call = this.childCalls.get(thread)
    if (call) {
      for (const e of childSteps(this.host.sessionId, call, n)) this.host.emit(e)
      return
    }
    if (this.unlinkedCount >= UNLINKED_CAP) return
    this.unlinked.set(thread, [...(this.unlinked.get(thread) ?? []), n])
    this.unlinkedCount += 1
  }

  /**
   * A `spawnAgent` call completed and named the threads it started (#222) — from the parent, or from a child that
   * started its own. Those threads' steps go under this card from now on, starting with whatever arrived before it.
   */
  noteSpawn(n: { method: string; params?: unknown }): void {
    if (n.method !== 'item/completed') return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent' || typeof item.id !== 'string') return
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    for (const thread of receivers) {
      if (typeof thread !== 'string' || this.childCalls.has(thread)) continue
      this.childCalls.set(thread, item.id)
      for (const e of this.children.link(thread, item.id, typeof item.prompt === 'string' ? item.prompt : '')) this.host.emit(e)
      const held = this.unlinked.get(thread) ?? []
      this.unlinked.delete(thread)
      this.unlinkedCount -= held.length
      for (const early of held) this.onChildNotification(thread, early)
    }
  }

  /** The parent's turn ended: what no launch call named by then is let go of (see `unlinked`) */
  noteTurnEnd(n: { method: string; params?: unknown }): void {
    if (n.method === 'turn/completed' && this.unlinked.size > 0) {
      console.error(`[codex] ${this.host.sessionId.slice(0, 8)} let go of ${this.unlinkedCount} items from ${this.unlinked.size} threads no spawnAgent call named`)
      this.unlinked.clear()
      this.unlinkedCount = 0
    }
  }
}
