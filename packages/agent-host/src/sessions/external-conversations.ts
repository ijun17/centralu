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

/**
 * Maximum number of lines of conversation to load. The older side is cut off first.
 * Pushing a session with hundreds of turns in whole makes the first render noticeably slow,
 * and what the person actually looks at is the last few turns anyway.
 */
const HISTORY_LIMIT = 200

/**
 * How much is read to catch up. Set more generously than the restore limit (200) — if the person
 * has been working outside for a while and comes back, the gap can exceed 200 lines, and if we
 * cannot find the last message we know, we cannot attach anything.
 */
const SYNC_LIMIT = 600

/**
 * **Up to what point** this session's external transcript has been read (exactly the `updatedAt`
 * the tool gave us).
 *
 * It does not matter that the unit differs between tools — the comparison is always between
 * values given by the same tool.
 */
const externalSyncedKey = (sessionId: string) => `external_synced:${sessionId}`

/**
 * A line read back from the tool into a stored row. A compaction point becomes the same row a live `compaction` event
 * leaves (`onEvent`: kind marker, the event as its payload), so the screen and the handoff pivot cannot tell them
 * apart (#303).
 */
function historyRow(sessionId: string, seq: number, h: HistoryMessage, fallbackTs: number): StoredMessage {
  const ts = h.ts ?? fallbackTs
  if (h.role === 'system') {
    return { sessionId, seq, role: 'system', kind: 'marker', payload: { type: 'compaction', sessionId, failed: false }, ts }
  }
  return { sessionId, seq, role: h.role, kind: 'text', payload: { text: h.text }, ts }
}

/** A stored marker of a compaction that folded something (a failed one did not) */
function isCompactionMarker(row: StoredMessage): boolean {
  const p = row.payload as { type?: string; failed?: boolean } | null
  return row.kind === 'marker' && p?.type === 'compaction' && !p.failed
}

/** Length of the conversation list received from the tool before waking — receiving this many may
 * mean the list was truncated (externalGone) */
const EXTERNAL_LIST_LIMIT = 200

export function truncate(s: string, max = 40): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
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
 * The conversations a tool keeps on its own side (#28, FR-10): the list of them in a folder, which session holds one,
 * whether one is gone, and the turns taken there outside Centralu, imported at creation and caught up at a wake.
 * Moved out of the session manager as it was (#428); what it reaches of the manager is `ExternalConversationsHost`.
 */
export class ExternalConversations {
  constructor(private readonly host: ExternalConversationsHost) {}

  /**
   * Conversation a tool holds -> when it was last changed (a short-lived cache).
   *
   * Used to be a Set holding only ids — because all we asked was whether it was alive or dead. But
   * the list also gives `updatedAt` (ExternalSessionSummary), and discarding that meant the very
   * next step asked "did anything change outside" by **re-reading the whole conversation**. That
   * was an answer we already had.
   */
  private readonly externalIndex = new Map<string, { ids: Map<string, number>; complete: boolean; at: number }>()

  /**
   * List of past sessions the tool has kept (including ones created from a terminal).
   *
   * Does not throw on failure — failing to fetch the list and failing to create a session are
   * different problems. Someone on an older tool version should still be able to use "new session".
   */
  async listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }> {
    const project = this.host.store.listProjects().find((p) => p.id === projectId)
    if (!project) return { supported: false, reason: 'Project not found', sessions: [] }

    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listExternalSessions) {
      return { supported: false, reason: `${tool} does not support listing past sessions`, sessions: [] }
    }

    try {
      const rows = await adapter.listExternalSessions(project.path, limit)
      /*
       * Opening a conversation that is already in the list again would create two of the same
       * session, so it is flagged to prevent that.
       *
       * Two things are preserved:
       *  - The check is done against the **original session it was resumed from**. It must not be
       *    done by externalId — if the tool issues a new identifier on resume, it would differ from
       *    the original and the check would say "not imported" every single time.
       *  - **A hidden session is not counted.** Hiding means "remove from my list", and the data
       *    still exists in the tool. If this check treated it as "already imported", there would be
       *    no way back.
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
   * Is there a **living session already holding on to** this tool conversation?
   *
   * The tool refuses when two writers try to write to one conversation (codex: "thread … already
   * has an active writer"). Even with different session ids, they conflict if they point at the
   * same original, so we block it on our side first and say **who is holding it**. The tool's own
   * raw error explains nothing to the person.
   */
  holderOf(externalId: string, exceptSessionId?: string): SessionInfo | null {
    for (const s of this.host.meta.values()) {
      if (s.id === exceptSessionId || !this.host.handles.has(s.id)) continue
      if (s.externalId === externalId || s.importedFrom === externalId) return s
    }
    return null
  }

  /**
   * Catches our record up to a conversation that continued on the tool's own side.
   *
   * Why this is needed: someone can start in Centralu, move to working with Claude or Codex in a
   * terminal, and come back. Whatever was exchanged in between piles up only in the tool while our
   * screen stays frozen (a dogfooding finding). The model remembers everything on resume, so **only
   * the screen is out of sync** — which makes it more confusing, not less.
   *
   * The rule for attaching: find **the last message we know about** in the tool's record and pull
   * in only what comes after it. Anything we ourselves sent also passed through the tool, so the
   * tool's record is the complete version — appending only the tail keeps it aligned without
   * duplicates. If it cannot be found, nothing is attached: staying out of sync is better than
   * stacking the same message twice.
   */
  async syncImportedHistory(info: SessionInfo, adapter: AgentAdapter): Promise<number> {
    const externalId = info.externalId ?? info.importedFrom
    if (!adapter.readExternalHistory || !externalId) return 0
    /*
     * **The session decides where to read from** (M4 P-6). Back when the caller passed
     * `project.path`, only the list lookup below asked for the session's real cwd, while history
     * was read from the project path — two keys inside one function. Claude keeps history under the
     * cwd the session actually ran in. Measured with SDK 0.3.263: asking with the project path, the
     * SDK managed to find a worktree session by searching `git worktree list` (2 cases), but a
     * session born in a folder that is not a worktree of that repository got 0 hits. A builder
     * session for a user-folder app in M4 is exactly that kind of session. cwd is no longer taken as
     * an argument now — it is decided once here, so the list lookup and the history read use the
     * same value.
     */
    const cwd = this.host.cwdFor(info)

    /*
     * **A record that has not changed is not read again.**
     *
     * This catch-up is a correction for "if this conversation continued outside the app (in a
     * terminal's tool), bring that in too". But when nothing was ever written outside, there was
     * nothing to read, and yet the full transcript was read every single time — and its size grows
     * with the conversation's length. Measured on a 775-turn codex thread: **48.6MB / 8.9 seconds.**
     * Worse, that 8.9 seconds is paid before the first message even goes out (the resume path below
     * awaits this). This is exactly what made waking a sleeping session and sending a message take 9
     * seconds.
     *
     * The tool cannot be asked to "give a little less". codex's thread/read has no notion of a count
     * — measured: passing a limit is simply ignored and it still returns the same 48.6MB. It is all
     * or nothing. So instead of receiving less, **we simply stop asking.** (Since #342 the codex
     * reader pages `thread/turns/list` from the newest turn and stops at the limit, so a read that
     * does happen costs the tail; not reading at all is still cheaper.)
     *
     * There is already something to ask instead: the `updatedAt` the list gives us, which the
     * externalGone check right before this already fetched and cached — free to use here.
     *
     * It matters that no tool name appears anywhere in this. This is not a special case for codex
     * but a rule of catch-up itself, so it applies to claude unchanged, and the next adapter added
     * simply inherits it. An adapter with no `listExternalSessions` has no way to know the time, so
     * it reads every time as before — **not knowing is never treated as skip** (the same direction
     * every other optional feature in this file degrades in).
     */
    /* The externalGone check right before this already filled the cache under the same key
       (`cwdFor`) — using a different key here would cost an extra list lookup that this was meant to
       save. If it is not in the list, the time is unknown, so it reads as before. */
    const changedAt = (await this.externalIndexOf(info.tool, cwd))?.ids.get(externalId) ?? null
    const key = externalSyncedKey(info.id)
    if (changedAt !== null && changedAt <= Number(this.host.store.appSetting(key) ?? '-1')) return 0
    /* Records the point that was read, even when there was nothing to attach — "read it" and "there
       was something new" are different facts, and failing to record the former means re-reading
       every single time instead of only when something changes. */
    const mark = () => {
      if (changedAt !== null) this.host.store.setAppSetting(key, String(changedAt))
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

    const ours = this.host.store.loadMessages(info.id, SYNC_LIMIT)
    /*
     * loadMessages gives one row as one message (#77) — neighboring assistant rows are not merged
     * either. This restore loop stitches them back together the same way: it reconciles against the
     * tool's record using the same text that the reader used to merge. Not merging is a rule of the
     * screen, and it is not meant to also change the standard catch-up compares against.
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

    // Everything new starts right after the last message we know about
    let start = -1
    if (lastText) {
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i]!
        if (h.role !== 'system' && h.text.trim() === lastText) {
          start = i + 1
          break
        }
      }
    } else if (ours.length === 0) {
      start = 0 // If our record is empty, everything is new
    }
    if (start < 0 || start >= history.length) {
      mark()
      return 0
    }

    /*
     * A compaction right after that message may already be ours (#303): one that ran while this host was watching
     * left its marker live, and the tool's record has the same compaction at the same spot. Those are skipped, as
     * many as our record holds after its last message, so the marker is stored once. One that ran outside the app
     * is not in our record and is attached like any other line.
     */
    let known = 0
    for (let i = ours.length - 1; i >= 0 && ours[i]!.kind !== 'text'; i--) {
      if (isCompactionMarker(ours[i]!)) known++
    }
    let skip = 0
    while (skip < known && history[start + skip]?.role === 'system') skip++
    const fresh = history.slice(start + skip)
    if (fresh.length === 0) {
      mark()
      return 0
    }
    const base = this.host.store.nextSeq(info.id)
    this.host.store.appendMessages(fresh.map((h, i) => historyRow(info.id, base + i, h, Date.now())))
    info.lastSeq = base + fresh.length - 1
    // This is a message that happened outside — since it was never read here, it stays marked unread
    this.host.store.upsertSession(info)
    mark()
    return fresh.length
  }

  /**
   * Restores past conversation for display on screen.
   *
   * This is a **display snapshot.** The context the model actually remembers lives in the tool
   * (resume carries that forward); what is saved here is the conversation record for a person to
   * read. The session is kept alive even on failure — failing to read the record is no reason to
   * block the conversation too.
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
    if (history.length === 0) return

    // nextSeq is based on MAX(seq) in the DB, so it **keeps returning the same value until something is
    // inserted.**
    // Fetched once and incremented locally (otherwise every row would land on the same seq and overwrite each
    // other).
    const base = this.host.store.nextSeq(info.id)
    const rows: StoredMessage[] = history.map((h, i) => historyRow(info.id, base + i, h, info.createdAt))
    this.host.store.appendMessages(rows)

    info.lastSeq = rows[rows.length - 1]!.seq
    // Conversation that was loaded already counts as read — it must not flag the person with an unread marker
    info.lastReadSeq = info.lastSeq
    if (info.autoNamed && info.name === 'New session') {
      const firstUser = history.find((h) => h.role === 'user')
      if (firstUser && firstUser.role === 'user') info.name = truncate(firstUser.text)
    }
    this.host.store.upsertSession(info)
    this.host.emit({ type: 'session_title', sessionId: info.id, title: info.name, auto: true })
  }

  /**
   * Whether a conversation to resume from still exists on the tool's side.
   *
   * Even the list lookup itself is not free (codex spins up an app-server for it), so this is cached
   * briefly. **When it cannot be determined, it is never treated as gone** — failing to fetch the list
   * and treating a perfectly fine session as deleted would break the conversation just because the
   * tool did not respond for a moment.
   */
  /**
   * The moment a handle is set aside, stamps "everything up to here is something I already know".
   *
   * The skip marker (externalSyncedKey) used to be updated only when catch-up actually read it. But
   * talking inside the app also bumps the tool's own updatedAt, so **the more a session was used every
   * day**, the more its next wake tripped the "did it change outside?" check and re-read the whole
   * transcript — even though every bit of it was something we ourselves had said. The skip ended up
   * never triggering for exactly the most common case: the first wake of the morning.
   *
   * A tool with a writer lock (capabilities.exclusiveWriter — codex) cannot be written to from outside
   * while we hold the handle. So stamping the moment the handle is set aside means: any change older
   * than that is entirely ours (skip it), and anything after it is genuinely external (read it). If a
   * crash prevents this from ever running, the marker stays stale, and a stale marker falls on the
   * side of reading — the safe direction.
   *
   * A tool with no lock at all (claude) never gets stamped: doing so would mean a message written
   * from outside while it was alive could never come in at all. The split is made on the declared
   * capability, not on the tool's name.
   */
  stampExternalSynced(sessionId: string): void {
    const m = this.host.meta.get(sessionId)
    if (!m || !(m.externalId ?? m.importedFrom)) return
    if (!this.host.adapters.get(m.tool)?.capabilities.exclusiveWriter) return
    this.host.store.setAppSetting(externalSyncedKey(sessionId), String(Date.now()))
  }

  async externalGone(m: SessionInfo, cwd: string): Promise<boolean> {
    const id = m.externalId ?? m.importedFrom
    if (!id) return false
    const index = await this.externalIndexOf(m.tool, cwd)
    if (!index) return false // If it could not be checked, it never blocks
    const { ids, complete } = index
    // If the resumed-from original is still alive, that counts too (resume may have issued a new id)
    if (ids.has(id) || (m.importedFrom && ids.has(m.importedFrom))) return false
    /*
     * **A full list means "unknown", not "gone"** (#165). The list only holds the most recent
     * EXTERNAL_LIST_LIMIT entries, so someone with a lot of conversation history in the same folder
     * would have an old conversation blocked with "no history" even though its file was perfectly
     * intact (clicking again just brings back the same 200). Codex never deletes threads, and
     * Claude's list even counts worktree conversations from the same repository together with it.
     */
    return complete
  }

  /**
   * The tool's list of stored conversations -> `external id -> when it was last changed`.
   *
   * Needed twice along the wake path (does it still exist? / did it change outside?). Asked once and
   * held for 30 seconds — codex spins up an app-server for even this one line (measured at 0.27
   * seconds). If the list could not be fetched, this is `null`: **not knowing and not existing are
   * never conflated.** When neither caller can tell, the direction taken is to never block anything.
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
