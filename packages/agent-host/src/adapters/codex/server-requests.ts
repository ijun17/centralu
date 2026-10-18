
/** Name of our MCP server attached via the bridge — elicitation acceptance judges by this name (defined in one place, #93) */
import { ORCHESTRATOR_MCP_NAME } from '../../sessions/orchestrator-tools.js'
import type { ApprovalDecision, ApprovalDetail, ApprovalScope } from '@cc/protocol'
import type { EventSink } from '../contract.js'
import type { ServerRequest } from './client.js'
import { approvalDetailFrom, toCodexDecision } from './approvals.js'
import { fileChangesOf } from './items.js'
import { CardIds, PendingCards } from '../session-kit.js'
import { AlwaysAllowRules, alwaysAllowKey } from '../always-allow.js'
import { turnIdOf } from './turn-reads.js'
import { asObj } from '../../json-value.js'

/** What the requests read of the session they belong to */
export type RequestsHost = {
  readonly sessionId: string
  emit: EventSink
  /** Answers a server request on the session's connection */
  respond(id: number | string, result: unknown): void
  threadId(): string | null
  appServers(): ReadonlySet<string>
  ownServer(): boolean
}

/**
 * A Codex session's server requests behind its approval cards (#169, #382, M4 A-5): approvals and app elicitations
 * raised as cards, the saved "always" rules, the file changes a card shows, and the cards Codex ends without an answer.
 */
export class CodexRequests {
  /**
   * Our requestId to the Codex server's request, with the thread and turn it was asked in. Codex ends a request
   * itself when its turn ends or is interrupted (and says so with `serverRequest/resolved`); the card has to close
   * with it, or an answer goes to a request id nobody is waiting on.
   */
  readonly approvals = new PendingCards<OpenRequest>()
  /** The ids of the cards this handle raises (see `CardIds`) */
  private readonly ids = new CardIds()
  private alwaysAllow = new AlwaysAllowRules()
  /**
   * The changes of each file-change item still open, by item id (#169). The approval request for that item
   * names it and carries nothing else (measured — see approvalDetailFrom), so the card's path and diff come
   * from here. Forgotten when the item completes, or when its thread's turn ends without completing it (an
   * interrupted or failed turn: Codex sends no `item/completed` for what it cut off, #392). `thread` is the
   * thread the item belongs to (the parent's or a child's), null when the notification named none.
   */
  private fileChanges = new Map<string, { thread: string | null; changes: { path: string; diff: string }[] }>()

  constructor(private readonly host: RequestsHost) {}

  /**
   * Closes the cards of server requests Codex ended without our answer. `serverRequest/resolved` names one request
   * (generated `ServerRequestResolvedNotification`, codex-cli 0.160.0: `{ threadId, requestId }`); a turn that ends
   * takes every request asked in it, whether or not that notification comes. A request we answered is already out of
   * `approvals`, so its own `serverRequest/resolved` finds nothing and closes nothing twice.
   */
  noteRequestEnded(n: { method: string; params?: unknown }): void {
    const p = (n.params ?? {}) as { threadId?: unknown; requestId?: unknown }
    if (n.method === 'serverRequest/resolved') {
      if (typeof p.requestId !== 'string' && typeof p.requestId !== 'number') return
      const serverId = String(p.requestId)
      this.closeApprovals((a) => String(a.serverId) === serverId)
      return
    }
    if (n.method !== 'turn/completed' && n.method !== 'turn/failed') return
    const turn = turnIdOf(n.params)
    if (typeof p.threadId !== 'string' || !turn) return
    this.closeApprovals((a) => a.threadId === p.threadId && a.turnId === turn)
  }

  /** Closes the matching cards as denied, without answering Codex: the request is already gone on its side */
  closeApprovals(match?: (a: OpenRequest) => boolean): void {
    this.approvals.release((requestId) => {
      this.host.emit({ type: 'approval_resolved', sessionId: this.host.sessionId, requestId, decision: 'deny' })
    }, match)
  }

  /** Keeps a file-change item's changes until it completes or its turn ends — see `fileChanges` */
  noteFileChange(n: { method: string; params?: unknown }): void {
    const p = (n.params ?? {}) as { item?: Record<string, unknown>; itemId?: unknown; changes?: unknown; threadId?: unknown }
    const thread = typeof p.threadId === 'string' ? p.threadId : null
    /*
     * A turn that ends takes its open items with it: their approval requests end with it too (`noteRequestEnded`), so
     * nothing reads them again. A thread runs one turn at a time, so every open item of that thread is that turn's. An
     * item whose notification named no thread is let go with the parent's turn.
     */
    if (n.method === 'turn/completed' || n.method === 'turn/failed') {
      const ended = thread ?? this.host.threadId()
      for (const [id, c] of this.fileChanges) if (c.thread === ended || (c.thread === null && ended === this.host.threadId())) this.fileChanges.delete(id)
      return
    }
    // The patch can be revised before it is approved (generated/v2/FileChangePatchUpdatedNotification.ts) — not measured
    if (n.method === 'item/fileChange/patchUpdated' && typeof p.itemId === 'string') {
      this.fileChanges.set(p.itemId, { thread, changes: fileChangesOf(p) })
      return
    }
    const item = p.item
    if (!item || item.type !== 'fileChange' || typeof item.id !== 'string') return
    if (n.method === 'item/started') this.fileChanges.set(item.id, { thread, changes: fileChangesOf(item) })
    else if (n.method === 'item/completed') this.fileChanges.delete(item.id)
  }

  onServerRequest(r: { id: number | string; method: string; params?: unknown }): void {
    /*
     * **elicitation has a different response shape from an approval.**
     *
     * When asking whether to use an MCP server, codex sends an elicitation and waits for an
     * `{ action }`. We were passing an unknown server request through as `{}`, which made codex
     * fail to deserialize it with "missing field `action`" and **treat it as a rejection** — the
     * screen only showed "permission denied", with no way to know the actual cause (measured).
     *
     * We accept our own server and reject unknown ones. Silently approving when there is no
     * screen to ask on would mean deciding on the user's behalf.
     */
    if (r.method.toLowerCase().includes('elicitation')) {
      const p = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as {
        serverName?: string
        message?: unknown
        _meta?: unknown
      }
      /*
       * **Tool approval for an attached app goes to our own approval card** (M4 A-5, decision 5).
       *
       * Codex asks whether to use an MCP tool through this same elicitation, and marks in `_meta`
       * that it is a tool approval. Rejecting it as before would mean the app tool never runs on
       * Codex, not even once (the same shape as plan "to confirm separately" 2). We only route to
       * a card for **tool approval on an app server we ourselves loaded onto this thread** — a
       * third party's server whose name happens to start with `app-` (from the user's
       * config.toml), and any elicitation that is not a tool approval (an input form), are still
       * rejected as before.
       *
       * Confirmed from source only (logged out, S-3): the string in the installed 0.153.4 binary
       * is `codex_approval_kind`, while current codex source uses `codex/approval_kind` — we read both.
       */
      if (typeof p.serverName === 'string' && this.host.appServers().has(p.serverName) && approvalKindOf(p._meta) === 'mcp_tool_call') {
        const requestId = this.ids.next('codex-req')
        this.approvals.set(requestId, { ...requestOrigin(r), elicitation: true })
        this.host.emit({ type: 'approval_request', sessionId: this.host.sessionId, requestId, detail: appApprovalDetail(p.serverName, p.message, p._meta) })
        return
      }
      // Only the server we loaded: without it, a `centralu` server could come from the person's own config.toml (#382)
      const ours = p.serverName === ORCHESTRATOR_MCP_NAME && this.host.ownServer()
      this.host.respond(r.id, { action: ours ? 'accept' : 'decline', content: null, _meta: null })
      return
    }

    /*
     * **A permissions request is not answered with a decision** (#169). Its response is
     * `{ permissions: GrantedPermissionProfile, scope }` (generated/v2/PermissionsRequestApprovalResponse.ts),
     * so the general path below, which answers `{ decision }`, sent Codex a reply of the wrong shape whatever
     * the person chose. There is no card that can show a permission profile yet, so it is refused the way
     * that type allows — nothing granted, for this turn only — and said in the log, so a request that
     * should have been asked about is one grep away. It only arrives with Codex's `request_permissions_tool`
     * feature turned on; not measured.
     */
    if (r.method === 'item/permissions/requestApproval') {
      console.error('[codex] permissions request refused, no card for it yet:', JSON.stringify(r.params ?? {}).slice(0, 500))
      this.host.respond(r.id, { permissions: {}, scope: 'turn' })
      return
    }

    if (!r.method.includes('requestApproval') && !r.method.endsWith('Approval')) {
      /*
       * A server request that is not an approval is passed through with an empty response (so we
       * do not stall as the protocol grows). But **we do log what was passed through** (#58) — when
       * an elicitation broke because of this empty {}, there was not a single log line to go on,
       * and finding the cause turned into a maze. A request is not a notification: our answer
       * changes what happens on the other side. The next time this happens, it should take one grep.
       */
      console.error('[codex] unknown server request answered with {}:', r.method)
      this.host.respond(r.id, {})
      return
    }
    const params = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as Record<
      string,
      unknown
    >

    const itemId = typeof params.itemId === 'string' ? params.itemId : ''
    const detail = approvalDetailFrom(r.method, params, this.fileChanges.get(itemId)?.changes)

    // Does not ask if it matches a saved "always allow" rule (the same rule as C-2)
    // A request that names no file has no key: a rule saved for "(no path)" would let every such request through
    const key = alwaysAllowKey(detail)
    if (key && this.alwaysAllow.allows(key)) {
      this.host.respond(r.id, { decision: 'accept' })
      return
    }

    const requestId = this.ids.next('codex-req')
    this.approvals.set(requestId, requestOrigin(r))
    this.host.emit({ type: 'approval_request', sessionId: this.host.sessionId, requestId, detail })
  }

  applyRules(matchers: readonly string[]): void {
    this.alwaysAllow.addAll(matchers)
  }

  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    _scope?: ApprovalScope,
    matcher?: string,
  ): boolean {
    const open = this.approvals.take(requestId)
    // This map is empty when the thread has been started fresh — a card raised before that has no id here
    if (open === undefined) return false
    const serverId = open.serverId

    if (open.elicitation) {
      /*
       * The answer to an app tool approval (M4 A-5). `always` is passed to Codex as "remember
       * this for the rest of the session" (`_meta.persist: "session"` -> ApprovedForSession).
       * Confirmed from source only (logged out, S-3): codex's
       * `parse_mcp_tool_approval_elicitation_response` reads accept together with this value.
       */
      this.host.respond(serverId, {
        action: decision === 'deny' ? 'decline' : 'accept',
        content: null,
        _meta: decision === 'always' ? { persist: 'session' } : null,
      })
      this.host.emit({ type: 'approval_resolved', sessionId: this.host.sessionId, requestId, decision })
      return true
    }
    if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
    this.host.respond(serverId, { decision: toCodexDecision(decision) })
    this.host.emit({ type: 'approval_resolved', sessionId: this.host.sessionId, requestId, decision })
    return true
  }
}

/** The approval kind named by an elicitation's `_meta` — 0.153.4 uses `codex_approval_kind`, current source uses `codex/approval_kind` */
function approvalKindOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const m = meta as Record<string, unknown>
  const kind = m.codex_approval_kind ?? m['codex/approval_kind']
  return typeof kind === 'string' ? kind : null
}

/**
 * The content of an app tool approval card — which app's tool, with what arguments. Uses the tool
 * title (`tool_title`) and arguments (`tool_params`) that Codex loads into `_meta`, and falls back
 * to Codex's own sentence (`message`) when those are absent.
 */
function appApprovalDetail(server: string, message: unknown, meta: unknown): ApprovalDetail {
  const m = asObj(meta)
  const title = typeof m.tool_title === 'string' && m.tool_title ? m.tool_title : typeof message === 'string' ? message : ''
  const params = m.tool_params === undefined ? '' : ` ${JSON.stringify(m.tool_params).slice(0, 1000)}`
  return { kind: 'other', raw: `${server} · ${title}${params}` }
}

/** Where a server request was asked, for closing its card when Codex ends it (see `approvals`) */
/**
 * A Codex server request behind one of our cards: its id, and the thread and turn it was asked in. `elicitation`
 * marks a card raised for an app tool's approval (M4 A-5), whose answer has a different shape (elicitation's
 * `{ action }`, not `{ decision }`).
 */
export type OpenRequest = { serverId: number | string; threadId: string | null; turnId: string | null; elicitation?: true }

function requestOrigin(r: ServerRequest): OpenRequest {
  const p = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as { threadId?: unknown; turnId?: unknown }
  return {
    serverId: r.id,
    threadId: typeof p.threadId === 'string' ? p.threadId : null,
    turnId: typeof p.turnId === 'string' ? p.turnId : null,
  }
}
