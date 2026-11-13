
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

/** One app this session has now (#2231) */
export type AttachedApp = {
  /** The app's name in the session, as the `app` tool lists it and takes it (`board`) */
  name: string
  /** The name it was attached under before #2231, kept in the session's book (#1141): `app-<name>` */
  server: string
  appId: string
  /**
   * The tool list we already know — null if it has never been read. The app is still the session's even when this is
   * null: listing it starts the app and finds out.
   */
  tools: AppToolSpec[] | null
}

/**
 * The external apps of this session (M4 A-5) as its adapter sees them. Since #2231 no adapter attaches an app itself:
 * the agent reaches every app through Centralu's own `app` tool, and the host decides, calls and asks at the call. What
 * the adapter still does is tell the host which conversation card a call is (B-1), and stop the calls with the session.
 *
 * **Which apps a session has is not decided here** — the manager decides it from the session kind and the project
 * (decision 4). One per handle: closing the handle closes this with it via `close()`.
 */
export type SessionApps = {
  /** The apps the session has now; the instructions name an app's help where a session starts with one (#957) */
  current(): AttachedApp[]
  /**
   * The adapter observed, in its own event stream, that the agent **started** an `app` call (M4 B-1): card `callId` calls
   * `tool` of `app` (the name the agent wrote) with `args`.
   *
   * A call through the stdio bridge (Codex, ACP) does not carry a card id, so what the adapter observed is matched, in
   * first-come order, against the call that follows by (app, tool, args). Either side may arrive first — whichever arrives
   * second gets matched then.
   */
  noteCall(callId: string, app: string, tool: string, args: unknown): void
  /**
   * That card's call has ended (success, failure, or rejection). If it was never matched, the record is discarded — a
   * call refused before it ran never reaches the app, so keeping the record around would let a later call with the same
   * arguments get matched to the old card.
   */
  callEnded(callId: string): void
  /**
   * Cancels every app call this session made — used when stopping the session (interrupt). Includes a call that already
   * returned early and a card still standing: work from a session the person stopped must not keep running in the
   * background. Cancellation is carried by the runtime down through the app and whatever work the app requested below it.
   */
  cancelAll(): void
  /** The handle is closing — cancels every call */
  close(): void
}

/** One of a session's apps as the `app` tool lists it (#2231): what its manifest calls it, besides its name in the session */
export type SessionAppEntry = AttachedApp & { title: string; description: string }

/**
 * How one `app` call is made (#2231). `waitMs` bounds the call on a path with a ceiling of its own (the stdio bridge Codex
 * and ACP agents reach Centralu through cuts a call at 280 s): the card and the app's run share it, and a run still going
 * past it answers "still running" with its run id. `callId` is the conversation card's id where the agent's MCP client
 * reports it (Claude Code: `_meta["claudecode/toolUseId"]`).
 */
export type AppCallOpts = { signal?: AbortSignal; waitMs?: number; callId?: string }

/**
 * What Centralu's `app` tool reaches of a session's live attachment (#2231): its apps, one app's tools (starting the app to
 * list them, within a bound), and the one call path, which checks, asks and records (sessions/session-apps.ts).
 */
export type SessionAppTools = {
  /** Asks the session's linked hosts for their apps again when the list kept is old (#1938); `current` reads what it kept */
  ready?(): Promise<void>
  current(): SessionAppEntry[]
  tools(server: string): Promise<AppToolSpec[]>
  call(server: string, tool: string, args: Record<string, unknown>, opts?: AppCallOpts): Promise<AppToolResult>
}

/**
 * How long an `app` call that came through the stdio bridge (Codex, ACP agents) may take before it answers (#2231): the
 * bridge gives up on a call at 280 s, and Codex at 300 s (`tool_timeout_sec`), so the host answers first with what it
 * knows: a card the person has not answered is withdrawn, and an app still running answers "still running" with its run
 * id. A Claude session's in-process call has no ceiling and waits.
 */
export const BRIDGE_ANSWER_MS = 240_000
