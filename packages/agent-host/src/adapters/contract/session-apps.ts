import type { PermissionPreset } from '@cc/protocol'

/**
 * A single tool of an external app attached to a session — carries the exact shape of an MCP
 * `Tool` (minus outputSchema).
 *
 * The description and the annotations (`annotations`) are carried through **unchanged**. The
 * description is what the model uses to choose a tool, and the annotations decide whether
 * approval can be skipped (read-only) — trimming either one turns it into a different tool than
 * what the app actually declared.
 */
export type AppToolSpec = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  _meta?: Record<string, unknown>
}

/** The result of an app tool call — the shape of MCP's `CallToolResult`. Even a failure is returned as `isError`, not thrown */
export type AppToolResult = {
  content: unknown[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/** A single app currently attached to this session */
export type AttachedApp = {
  /** The server name used in the session (`app-<id>`) */
  server: string
  appId: string
  /**
   * The tool list we already know — null if it has never been read. The app is still attached
   * even when this is null: `tools()` starts the app and finds out when it is needed.
   */
  tools: AppToolSpec[] | null
}

/**
 * An external app attached to this session (M4 A-5) — each adapter attaches it its own way.
 *
 *   Claude  an in-process proxy server per app. Changes the server set with no restart as apps come and go
 *   Codex   an stdio bridge per app. Attached only when a thread starts or resumes (there is no way to add one while it is running)
 *
 * **Which apps get attached is not decided here** — the manager decides it from the session kind
 * and the project, and passes it down (decision 4). What the adapter receives is an
 * already-filtered list, plus the single path every call goes through (`call`). One per handle:
 * closing the handle closes this with it via `close()`.
 */
export type SessionApps = {
  current(): AttachedApp[]
  /** Attached apps or their tools may have changed — time to read `current()` again. Unsubscribe with the returned function */
  onChange(listener: () => void): () => void
  /** An app's agent tools. If unknown, starts the app to find out (the wait is bounded) */
  tools(server: string): Promise<AppToolSpec[]>
  /**
   * Calls an app tool — the caller is this session. An unattached app or a nonexistent tool comes
   * back as a rejected result.
   *
   * If `waitMs` is given, a call taking longer than that **returns a run id and "still running"
   * first** — the call itself does not stop, and the result is followed up through that app
   * server's own `run_status` tool. Used by a tool that has its own call ceiling externally
   * (Codex, 300 seconds). A tool with effectively no ceiling (Claude's in-process server) does not
   * get this and simply waits.
   */
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal
      waitMs?: number
      /**
       * The conversation card id for this call (the adapter's `tool_call` callId) — given **only
       * when the agent's MCP client reports it** (Claude Code: `_meta["claudecode/toolUseId"]`).
       * This decides which card the in-conversation screen (B-1) settles under. If absent, it is
       * matched against what was recorded via `noteCall`.
       */
      callId?: string
    },
  ): Promise<AppToolResult>
  /**
   * The adapter observed, in its own event stream, that the agent **started** calling an attached
   * app's tool (M4 B-1).
   *
   * A call going through a bridge (Codex) does not carry a card id — Codex does not put that id
   * on the MCP request (we found no evidence that it does). So we record what the adapter
   * observed ("card X calls server S's tool T with argument A"), and match it, in first-come
   * order, against the call that follows by (server, tool, args). Either side may arrive first —
   * whichever arrives second gets matched then.
   */
  noteCall(callId: string, server: string, tool: string, args: unknown): void
  /**
   * That card's call has ended (success, failure, or rejection). If it was never matched, the
   * record is discarded — a call rejected at approval never reaches the app, so keeping the
   * record around would let a later call with the same arguments get matched to the old card.
   */
  callEnded(callId: string): void
  /**
   * Whether the app itself declared this tool read-only (`readOnlyHint: true`) — the basis for the
   * approval decision (decision 5). Only looks at the attached app's already-read agent tool
   * list. Defaults to false when unknown (leans toward asking).
   */
  readOnly(server: string, tool: string): boolean
  /**
   * Whether this call runs with no approval card: a read-only tool, or a write the app declared `local` or
   * (for the app of this session's own project, under `normal`) `routine` (`apps/external/tool-risk.ts`). Judged
   * from the attached app's already-read tool list, like `readOnly`; `false` when unknown. `args` is absent where
   * the arguments are not known yet (Codex decides before the call), and then a tool whose risk depends on them asks.
   */
  unasked(server: string, tool: string, preset: PermissionPreset, args?: Record<string, unknown>): boolean
  /**
   * Cancels every app call this session made — used when stopping the session (interrupt).
   * Includes a call that already returned early (`waitMs`): work from a session the person
   * stopped must not keep running in the background. Cancellation is carried by the runtime down
   * through the app and whatever work the app requested below it.
   */
  cancelAll(): void
  /** The handle is closing — cancels every call and unsubscribes */
  close(): void
}
