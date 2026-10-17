import type { CreateSessionOpts } from '../adapters/contract.js'
import { handoffNoteDir, sweepHandoffNotes, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import { buildHandoffRecord } from './handoff-record.js'
import type { SessionAppWiringHost } from './session-app-wiring.js'

/**
 * What the handoff notes reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type HandoffNotesHost = Pick<DelegationHost, 'adapters' | 'meta' | 'store' | 'trashing'> & Pick<SessionAppWiringHost, 'sessionOf'>

/**
 * A handoff's note as the sessions meet it (#102, #106, #142, #738): written from a dead agent's record or a living
 * agent's answer into the data folder, the folder a successor may read it from, the sweep of notes nobody owns, and
 * the live session that took over. Moved out of the session manager as it was (#428); what it reaches of the manager
 * is `HandoffNotesHost`.
 */
export class HandoffNotes {
  constructor(private readonly host: HandoffNotesHost) {}

  /**
   * The live session that took over from this one by a handoff (#738), or null: the newest successor still here. A
   * successor that was removed, or is being removed right now (`trashing`), passes on to its own successors, newest
   * first, as its children did; the nearest generation with a live one wins.
   */
  handoffHeir(sessionId: string): string | null {
    const seen = new Set([sessionId])
    let generation = [sessionId]
    try {
      while (generation.length) {
        const heirs = generation.flatMap((at) => this.host.store.handoffHeirs(at)).filter((h) => !seen.has(h.sessionId))
        for (const h of heirs) seen.add(h.sessionId)
        const live = heirs.find((h) => !h.trashed && this.host.meta.has(h.sessionId) && !this.host.trashing.has(h.sessionId))
        if (live) return live.sessionId
        generation = heirs.map((h) => h.sessionId)
      }
    } catch (e) {
      // A delete never fails over this: the children stay on their own, as before #738
      console.error(`[agent-host] no handoff heir read for ${sessionId.slice(0, 8)}: ${(e as Error).message}`)
    }
    return null
  }

  /**
   * The note folder a successor reads from (#142) — only a project session that inherited a handoff
   * gets it, and only that one project's folder. Each adapter uses it its own way
   * (`CreateSessionOpts.readableDirs`: only Claude uses it, Codex does not restrict reads at all).
   */
  handoffReadDirs(projectId: string | null | undefined, inherits: boolean): Pick<CreateSessionOpts, 'readableDirs'> {
    if (!inherits || !projectId) return {}
    try {
      return { readableDirs: [handoffNoteDir(projectId)] }
    } catch {
      // A projectId that is not a real id — there is no folder to open. The note gets read on request instead
      return {}
    }
  }

  /**
   * Deletes a handoff note that has no owner left (#106).
   *
   * **This never cleans up at a turn boundary.** #102 moved this sweep from right after
   * `createSession` to the completion of the successor's first turn, but even that still ran ahead
   * of the reader: it checked neither whether the first turn succeeded nor whether the note was ever
   * actually read. In a real incident, the first turn died with a 400 in under a second, and the
   * successor was left holding a path to a file that was already gone. "Was it read" is not a fact
   * we can observe, so the whole idea of hanging this off a turn is abandoned.
   *
   * The two moments left cannot race a reader — when a session disappears (that session will never
   * read again) and at startup (no handoff is in progress). What is left behind is just one file in
   * the data folder.
   *
   * **Cleanup only ever touches the data folder** (#142). It used to read and delete
   * `<project>/.centralu/handoff` under every registered project, but that folder belongs to the
   * user's own repository, so a single symlink could point it at the repository root or outside the
   * repository entirely (measured: a startup cleanup once deleted a README.md). A note in that old
   * location is no longer ours — it is never looked at.
   */
  async sweepOrphanHandoffNotes(projectId?: string): Promise<void> {
    /*
     * Ownership is asked per note, at the moment that note is judged — not snapshotted before the folder
     * is read. The sweep awaits the listing and each delete, and in that time a handoff can finish and its
     * predecessor be deleted (the last step of a handoff): the predecessor leaves `meta`, and only a
     * claim or the trash read now still says the note has a reader. A snapshot taken earlier said neither,
     * and the note the successor had just been pointed at was deleted.
     */
    await sweepHandoffNotes(
      (owner) =>
        this.host.meta.has(owner) ||
        // A session in the trash still owns its note (#204) — restoring it must find it; only purging lets it go
        this.host.store.trashedIds().has(owner) ||
        this.host.store.handoffPredecessors().has(owner),
      projectId,
    )
  }

  /**
   * A dead-agent handoff record (#78) — built **without calling that session's tool.**
   *
   * The moment this method is called is exactly when that tool cannot respond: the only material
   * available is the full original text in our own store, plus (for codex) the last compact summary
   * from the rollout file. Neither failing blocks the record from being generated — if there is no
   * summary, the builder falls back to compressing the original text.
   *
   * **The result is written out as a file** (#102). The key point is that it writes to the same slot
   * as the mode where an agent gives it as an answer (exportHandoffNote): only the material differs,
   * and the first message a successor receives ends up the same either way. text is also returned
   * alongside it so the caller can pull out the first few lines as a preview.
   */
  async exportHandoffRecord(sessionId: string, toTool?: string): Promise<{ text: string; path: string }> {
    const m = this.host.sessionOf(sessionId)
    if (!m.projectId) throw rpcError('Only project sessions can hand off')
    const rows = this.host.store.loadMessages(sessionId, 1_000_000)
    // Pivot = the last **successful** compaction marker — a failed compaction folded nothing at all
    let pivotSeq: number | null = null
    for (const r of rows) {
      const p = r.payload as { type?: string; failed?: boolean }
      if (r.kind === 'marker' && p.type === 'compaction' && !p.failed) pivotSeq = r.seq
    }
    const externalId = m.externalId ?? m.importedFrom
    const summary = externalId
      ? ((await this.host.adapters.get(m.tool)?.lastCompactSummary?.(externalId).catch(() => null)) ?? null)
      : null
    const text = buildHandoffRecord({ name: m.name, tool: m.tool, toTool, summary, rows, pivotSeq })
    // Written into the data folder (#142) — nothing at all is written into the user's own repository
    return { text, path: await writeHandoffNote(m.projectId, sessionId, text) }
  }

  /**
   * A note for a living handoff (#142) — the host writes what an agent gives **as its answer** out to
   * a file.
   *
   * The agent itself used to write directly to `<project>/.centralu/handoff/<id>.md`. Once the note
   * moved outside the repository (into the data folder), that write turned into a request for more
   * permission: Claude asks before writing outside the working folder, and Codex's workspace-write
   * sandbox blocks writes outside its write root — and `turn/start.sandboxPolicy`, which would widen
   * that root, applies to "this turn and **every turn after it**" and replaces the user's whole
   * sandbox configuration wholesale. So the agent is never granted any extra permission at all, and
   * the write is instead done by the host, which already writes to the data folder anyway.
   *
   * **The answer is read from the store** — not the streaming chunks the screen has assembled
   * (mixed-in chunks were exactly why this moved to a file read in the first place). afterSeq is the
   * last seq right before the request was sent. The first person-message after it is the request, and
   * the **last** assistant text before the next person-message after that is the note: whatever the
   * agent said while first checking the state, and any tool calls, come before the request and do not
   * count, and text that comes before the request (a report from a turn still running, the answer to
   * a past handoff) is not counted either. If a turn is still running, this returns null — its last
   * text at that point could be a status update in progress rather than the note.
   */
  async exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null> {
    const m = this.host.sessionOf(sessionId)
    if (!m.projectId) throw rpcError('Only project sessions can hand off')
    if (inTurn(m.state)) return null
    let note = ''
    let asked = false
    for (const r of this.host.store.loadMessagesFrom(sessionId, afterSeq, 1_000_000)) {
      if (r.role === 'user') {
        // A person-message that comes after the request is no longer an answer to this request
        if (asked) break
        asked = true
        continue
      }
      if (asked && r.role === 'assistant' && r.kind === 'text') note = (r.payload as { text?: string }).text ?? ''
    }
    note = note.trim()
    if (!note) return null
    return { text: note, path: await writeHandoffNote(m.projectId, sessionId, note) }
  }
}
