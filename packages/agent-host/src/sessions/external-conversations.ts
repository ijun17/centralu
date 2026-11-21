import { oneLineText, recordedRowKind } from '@cc/protocol'
import { remember } from './folder-cache.js'
import type {
  ExternalSession,
  NormalizedEvent,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'
import type { AgentAdapter, HistoryMessage, SessionHandle } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { isCentraluNote } from '../adapters/input-receipts.js'

/**
 * Maximum number of lines of conversation to load, the older side cut first: pushing a session with hundreds of turns in whole
 * makes the first render noticeably slow, and the person looks at the last few turns anyway.
 */
const HISTORY_LIMIT = 200

/**
 * How much is read to catch up. More generous than the restore limit (200): after a while outside, the gap can exceed 200
 * lines, and if the last message we know is not found, nothing can be attached.
 */
const SYNC_LIMIT = 600

/**
 * **Up to what point** this session's external transcript has been read (exactly the `updatedAt` the tool gave). Only ever
 * compared with values from the same tool, so it does not matter that the unit differs between tools.
 */
const externalSyncedKey = (sessionId: string) => `external_synced:${sessionId}`

/**
 * Centralu's own Continue note read back (`isCentraluNote`). It went in through Centralu's channel and left its notice line, so
 * it is never stored as a message of the person's, wherever the anchor falls.
 */
const ownNote = (h: HistoryMessage): boolean => h.role === 'user' && isCentraluNote(h.text)

/**
 * A line read back from the tool into a stored row. An event (a tool call, its result, a compaction point) becomes the
 * same row the event leaves live (`persistMessage`: its recorded kind, the event as its payload, under this session's
 * id), so the screen, the handoff record and its pivot cannot tell them apart (#303, #843).
 */
function historyRow(sessionId: string, seq: number, h: HistoryMessage, fallbackTs: number): StoredMessage {
  const ts = h.ts ?? fallbackTs
  if (h.role === 'system') {
    const payload = { ...h.event, sessionId }
    return { sessionId, seq, role: 'system', kind: recordedRowKind(payload) ?? 'marker', payload, ts }
  }
  // Words read from the tool's record carry no input id (#1639): marked, so they do not read as a row an older build wrote
  return { sessionId, seq, role: h.role, kind: 'text', payload: { text: h.text, ...(h.role === 'user' ? { transcript: true } : {}) }, ts }
}

/**
 * What a stored row and a line read back are the same record of, when it is not words: a compaction that folded
 * something (a failed one did not), or a tool call or result by its id. Null for anything else.
 */
function eventKey(row: StoredMessage): string | null {
  const p = row.payload as { type?: string; failed?: boolean; callId?: string } | null
  if (row.kind === 'marker') return p?.type === 'compaction' && !p.failed ? 'compaction' : null
  if (row.kind === 'tool_call' || row.kind === 'tool_result') return `${row.kind}:${p?.callId ?? ''}`
  return null
}

/** Length of the conversation list received from the tool before waking — receiving this many may
 * mean the list was truncated (externalGone) */
const EXTERNAL_LIST_LIMIT = 200

export function truncate(s: string, max = 40): string {
  return oneLineText(s, max)
}

/**
 * What the external-conversation code reaches of the session manager (#428), typed as the manager declares each
 * member. The manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type ExternalConversationsHost = {
  readonly adapters: Map<string, AgentAdapter>
  cwdFor: (m: SessionInfo) => string
  readonly emit: (e: NormalizedEvent) => void
  readonly handles: Map<string, SessionHandle>
  readonly meta: Map<string, SessionInfo>
  readonly store: Store
}

/**
 * The conversations a tool keeps on its own side (#28, FR-10): the list of them in a folder, which session holds one, whether
 * one is gone, and the turns taken there outside Centralu, imported at creation and caught up at a wake. What it reaches of the
 * manager is `ExternalConversationsHost`.
 */
export class ExternalConversations {
  constructor(private readonly host: ExternalConversationsHost) {}

  /**
   * Conversation a tool holds -> when it was last changed (a short-lived cache). It keeps the `updatedAt` the list gives
   * (ExternalSessionSummary), not just the ids: without it, asking "did anything change outside" meant re-reading the whole
   * conversation.
   */
  private readonly externalIndex = new Map<string, { ids: Map<string, number>; complete: boolean; at: number }>()

  /**
   * List of past sessions the tool has kept (including ones created from a terminal). Does not throw on failure: failing to
   * fetch the list and failing to create a session are different problems, and someone on an older tool version should still be
   * able to use "new session".
   */
  async listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }> {
    const project = this.host.store.projects.listProjects().find((p) => p.id === projectId)
    if (!project) return { supported: false, reason: 'Project not found', sessions: [] }

    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listExternalSessions) {
      return { supported: false, reason: `${tool} does not support listing past sessions`, sessions: [] }
    }

    try {
      const rows = await adapter.listExternalSessions(project.path, limit)
      /*
       * Opening a conversation that is already in the list again would create two of the same session, so it is flagged. The
       * check is against the **original session it was resumed from**, not by externalId: a tool that issues a new identifier
       * on resume would differ from the original and the check would say "not imported" every single time. **A hidden session
       * is not counted:** hiding means "remove from my list" while the data still exists in the tool, so counting it as already
       * imported would leave no way back.
       */
      const known = new Map<string, string>()
      for (const s of this.host.meta.values()) {
        if (s.tool !== tool) continue
        // One session can have multiple identifiers: the original it was resumed from, and the
        // current one. (They differ if the tool issues a new id on resume.)
        for (const key of [s.importedFrom, s.externalId]) {
          if (key && !known.has(key)) known.set(key, s.id)
        }
      }
      return {
        supported: true,
        sessions: rows.map((r) => ({
          externalId: r.externalId,
          tool,
          title: r.title,
          updatedAt: r.updatedAt,
          createdAt: r.createdAt ?? null,
          branch: r.branch ?? null,
          imported: known.has(r.externalId),
          importedAs: known.get(r.externalId) ?? null,
        })),
      }
    } catch (err) {
      return { supported: false, reason: (err as Error).message, sessions: [] }
    }
  }

  /**
   * Is there a **living session already holding** this tool conversation? The tool refuses two writers on one conversation
   * (codex: "thread … already has an active writer"), also with different session ids that point at the same original, so we
   * block it on our side first and say **who is holding it**: the tool's own raw error explains nothing to the person.
   */
  holderOf(externalId: string, exceptSessionId?: string): SessionInfo | null {
    for (const s of this.host.meta.values()) {
      if (s.id === exceptSessionId || !this.host.handles.has(s.id)) continue
      if (s.externalId === externalId || s.importedFrom === externalId) return s
    }
    return null
  }

  /**
   * Catches our record up to a conversation that continued on the tool's own side (started in Centralu, continued in a terminal
   * with Claude or Codex, then back): what was exchanged in between piles up only in the tool and the screen stays frozen,
   * though the model remembers everything on resume, so **only the screen is out of sync**. The rule for attaching: find **the
   * last message we know about** in the tool's record and pull in only what comes after it. Anything we sent also passed
   * through the tool, so its record is the complete version, and appending only the tail keeps it aligned without duplicates.
   * If it cannot be found, nothing is attached: out of sync is better than the same message twice.
   */
  async syncImportedHistory(info: SessionInfo, adapter: AgentAdapter): Promise<number> {
    const externalId = info.externalId ?? info.importedFrom
    if (!adapter.readExternalHistory || !externalId) return 0
    /*
     * **The session decides where to read from** (M4 P-6): Claude keeps history under the cwd the session actually ran in.
     * Measured with SDK 0.3.263: asking with the project path found a worktree session by searching `git worktree list` (2
     * cases), but a session born in a folder that is not a worktree of that repository got 0 hits (a builder session for a
     * user-folder app in M4 is exactly that). cwd is decided once here, so the list lookup and the history read use the same
     * value.
     */
    const cwd = this.host.cwdFor(info)

    /*
     * **A record that has not changed is not read again.** This catch-up corrects for a conversation that continued outside the
     * app; when nothing was written outside there was nothing to read, yet the full transcript was read every time, its size
     * growing with the conversation. Measured on a 775-turn codex thread: **48.6MB / 8.9 seconds**, paid before the first
     * message goes out (the resume path below awaits it), which made waking a sleeping session and sending a message take 9
     * seconds. The tool cannot be asked for less: codex's thread/read has no notion of a count (measured: a limit is ignored
     * and it returns the same 48.6MB), so **we stop asking** (the codex reader pages `thread/turns/list` from the newest turn
     * and stops at the limit, #342, so a read that does happen costs the tail; not reading is still cheaper). What we ask
     * instead is the `updatedAt` the list gives, already fetched and cached by the `externalGone` check right before. No tool
     * name appears here: it is a rule of catch-up, so Claude and the next adapter inherit it. An adapter with no
     * `listExternalSessions` cannot know the time and reads every time: **not knowing is never treated as skip**.
     */
    /* The externalGone check right before this already filled the cache under the same key
       (`cwdFor`) — using a different key here would cost an extra list lookup that this was meant to
       save. If it is not in the list, the time is unknown, so it reads as before. */
    const changedAt = (await this.externalIndexOf(info.tool, cwd))?.ids.get(externalId) ?? null
    const key = externalSyncedKey(info.id)
    if (changedAt !== null && changedAt <= Number(this.host.store.settings.appSetting(key) ?? '-1')) return 0
    /* Records the point that was read, even when there was nothing to attach — "read it" and "there
       was something new" are different facts, and failing to record the former means re-reading
       every single time instead of only when something changes. */
    const mark = () => {
      if (changedAt !== null) this.host.store.settings.setAppSetting(key, String(changedAt))
    }

    let history: HistoryMessage[]
    try {
      history = await adapter.readExternalHistory(externalId, cwd, SYNC_LIMIT)
    } catch {
      // The conversation continues even if this cannot be read (no marker is written either — nothing was
      // actually read)
      return 0
    }
    if (history.length === 0) {
      mark()
      return 0
    }

    const ours = this.host.store.messages.loadMessages(info.id, SYNC_LIMIT)
    /*
     * loadMessages gives one row as one message (#77), neighboring assistant rows are not merged; this restore loop stitches
     * them back together the same way, reconciling against the tool's record with the text the reader merged. Not merging is a
     * rule of the screen, not meant to change the standard catch-up compares against.
     */
    const lastMessageText = (): string | undefined => {
      const parts: string[] = []
      for (let i = ours.length - 1; i >= 0; i--) {
        const r = ours[i]!
        if (r.kind !== 'text') {
          if (parts.length > 0) break // Hitting a different kind means this is the start of that response
          continue
        }
        const t = (r.payload as { text?: string }).text ?? ''
        if (r.role !== 'assistant') return parts.length > 0 ? parts.join('') : t
        parts.unshift(t)
      }
      return parts.length > 0 ? parts.join('') : undefined
    }
    const lastText = lastMessageText()?.trim()

    /*
     * Everything new starts right after the last line we know about: our last message, found by its words, or the last input
     * Centralu itself wrote there, known by the id it gave the line (`HistoryMessage.sent`), whichever is later (#1618). A note
     * or mail goes in through Centralu's channel and leaves no row of its words, so the words alone would anchor on the message
     * before it: the note would be attached as the person's message, and the calls after it, already stored live, a second
     * time. Words we hold that the record lacks still attach nothing: the id only moves the anchor later, never past words of
     * ours it cannot place.
     */
    const said = lastText ? history.findLastIndex((h) => h.role !== 'system' && h.text.trim() === lastText) : -1
    const wrote = history.findLastIndex((h) => h.role === 'user' && h.sent === true)
    let start = -1
    if (ours.length === 0) start = 0 // If our record is empty, everything is new
    else if (said >= 0 || (!lastText && wrote >= 0)) start = Math.max(said, wrote) + 1
    if (start < 0 || start >= history.length) {
      mark()
      return 0
    }

    /*
     * The events after that line may already be ours (#303, #843): a compaction or a tool call that ran while this host was
     * watching left its row live, and the tool's record has the same event. Each one our record holds is skipped, as many times
     * as it holds it, so the row is stored once; the rest is attached. The two need not be in the same order or complete:
     * parallel calls finish in another order live than the record lists them, a background agent's launch result is in the
     * record but came later live (or never), and a row an older host did not store can come first, so stopping at the first
     * event we lack would store every later one twice. A tool call or result is the same record by its id wherever it falls,
     * also behind a line we did not store (#1618: the CLI's own "No response requested." where it resumed a cut turn). A
     * compaction has no id: only one our record holds after its last message is taken for one right after the anchor. An event
     * that ran outside the app is attached like any other line.
     */
    const known = new Map<string, number>()
    let trailing = true
    for (let i = ours.length - 1; i >= 0; i--) {
      if (ours[i]!.kind === 'text') trailing = false
      const key = eventKey(ours[i]!)
      if (key && (key !== 'compaction' || trailing)) known.set(key, (known.get(key) ?? 0) + 1)
    }
    let end = start
    while (history[end]?.role === 'system') end++
    const fresh = history.slice(start).filter((h, i) => {
      if (ownNote(h)) return false
      const key = eventKey(historyRow(info.id, 0, h, 0))
      const left = key && (key !== 'compaction' || start + i < end) ? (known.get(key) ?? 0) : 0
      if (!key || left === 0) return true
      known.set(key, left - 1)
      return false
    })
    if (fresh.length === 0) {
      mark()
      return 0
    }
    const base = this.host.store.messages.nextSeq(info.id)
    this.host.store.messages.appendMessages(fresh.map((h, i) => historyRow(info.id, base + i, h, Date.now())))
    info.lastSeq = base + fresh.length - 1
    // This is a message that happened outside — since it was never read here, it stays marked unread
    this.host.store.sessions.upsertSession(info)
    mark()
    return fresh.length
  }

  /**
   * Restores past conversation for display on screen. A **display snapshot:** the context the model remembers lives in the tool
   * (resume carries that forward); what is saved here is the conversation record for a person to read. The session is kept
   * alive even on failure: failing to read the record is no reason to block the conversation.
   */
  async importHistory(
    info: SessionInfo,
    adapter: AgentAdapter,
    externalId: string,
    cwd: string,
  ): Promise<void> {
    if (!adapter.readExternalHistory) return
    let history: HistoryMessage[]
    try {
      history = await adapter.readExternalHistory(externalId, cwd, HISTORY_LIMIT)
    } catch (err) {
      this.host.emit({
        type: 'error',
        sessionId: info.id,
        error: {
          code: 'internal',
          message: `Could not load past conversation: ${(err as Error).message}`,
          retryable: false,
        },
      })
      return
    }
    history = history.filter((h) => !ownNote(h))
    if (history.length === 0) return

    // nextSeq is based on MAX(seq) in the DB, so it **keeps returning the same value until something is inserted:** fetched
    // once and incremented locally, or every row would land on the same seq and overwrite each other.
    const base = this.host.store.messages.nextSeq(info.id)
    const rows: StoredMessage[] = history.map((h, i) => historyRow(info.id, base + i, h, info.createdAt))
    this.host.store.messages.appendMessages(rows)

    info.lastSeq = rows[rows.length - 1]!.seq
    // Conversation that was loaded already counts as read — it must not flag the person with an unread marker
    info.lastReadSeq = info.lastSeq
    if (info.autoNamed && info.name === 'New session') {
      const firstUser = history.find((h) => h.role === 'user')
      if (firstUser && firstUser.role === 'user') info.name = truncate(firstUser.text)
    }
    this.host.store.sessions.upsertSession(info)
    this.host.emit({ type: 'session_title', sessionId: info.id, title: info.name, auto: true })
  }

  /**
   * The moment a handle is set aside, stamps "everything up to here is something I already know". The skip marker
   * (externalSyncedKey) cannot be updated only when catch-up read: talking inside the app also bumps the tool's own updatedAt,
   * so **the more a session was used**, the more its next wake would trip the "did it change outside?" check and re-read the
   * whole transcript, though all of it was ours. A tool with a writer lock (capabilities.exclusiveWriter — codex) cannot be
   * written to from outside while we hold the handle, so stamping at that moment means any change older than it is entirely
   * ours (skip it) and anything after it is genuinely external (read it); if a crash prevents the stamp, the stale marker falls
   * on the side of reading, the safe direction. A tool with no lock (claude) never gets stamped: a message written from outside
   * while it was alive could then never come in. The split is made on the declared capability, not on the tool's name.
   */
  stampExternalSynced(sessionId: string): void {
    const m = this.host.meta.get(sessionId)
    if (!m || !(m.externalId ?? m.importedFrom)) return
    if (!this.host.adapters.get(m.tool)?.capabilities.exclusiveWriter) return
    this.host.store.settings.setAppSetting(externalSyncedKey(sessionId), String(Date.now()))
  }

  /**
   * Whether a conversation to resume from still exists on the tool's side. Cached briefly, as even the list lookup is not free
   * (codex spins up an app-server for it). **When it cannot be determined, it is never treated as gone:** treating a perfectly
   * fine session as deleted because the tool did not respond for a moment would break the conversation.
   */
  async externalGone(m: SessionInfo, cwd: string): Promise<boolean> {
    const id = m.externalId ?? m.importedFrom
    if (!id) return false
    const index = await this.externalIndexOf(m.tool, cwd)
    if (!index) return false // If it could not be checked, it never blocks
    const { ids, complete } = index
    // If the resumed-from original is still alive, that counts too (resume may have issued a new id)
    if (ids.has(id) || (m.importedFrom && ids.has(m.importedFrom))) return false
    /*
     * **A full list means "unknown", not "gone"** (#165): the list holds only the most recent EXTERNAL_LIST_LIMIT entries, so
     * an old conversation in a folder with a lot of history would be blocked with "no history" though its file is intact
     * (clicking again just brings back the same 200). Codex never deletes threads, and Claude's list counts worktree
     * conversations from the same repository too.
     */
    return complete
  }

  /**
   * The tool's list of stored conversations -> `external id -> when it was last changed`. Needed twice along the wake path
   * (does it still exist? did it change outside?), so asked once and held for 30 seconds: codex spins up an app-server for even
   * this one line (measured at 0.27 seconds). If the list could not be fetched this is `null`: **not knowing and not existing
   * are never conflated**, and where neither caller can tell, nothing is blocked.
   */
  private async externalIndexOf(
    tool: ToolName,
    cwd: string,
  ): Promise<{
    ids: Map<string, number>
    /** The list was not truncated — if it is not here, it really does not exist */
    complete: boolean
  } | null> {
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listExternalSessions) return null

    const key = `${tool}:${cwd}`
    const cached = this.externalIndex.get(key)
    if (cached && Date.now() - cached.at < 30_000) return cached
    try {
      const rows = await adapter.listExternalSessions(cwd, EXTERNAL_LIST_LIMIT)
      const index = { ids: new Map(rows.map((r) => [r.externalId, r.updatedAt])), complete: rows.length < EXTERNAL_LIST_LIMIT }
      remember(this.externalIndex, key, { ...index, at: Date.now() })
      return index
    } catch {
      return null
    }
  }
}
