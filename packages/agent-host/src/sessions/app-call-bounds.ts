/*
 * The bounds a session's app calls share with the answers to a linked host's (#1938, links/linked-app-calls.ts) and the
 * caller's side of those (links/linked-apps.ts). A leaf, so both sides import them without a cycle through session-apps.ts.
 */

/**
 * The upper bound on how long we wait when an app whose tool list is unknown has to be spun up
 * to find out.
 *
 * The Claude CLI calls `tools/list` for every attached server as it starts a session, and Codex
 * waits for the bridge's `tools/list` as it starts a thread. If an app hangs while starting, the
 * session hangs with it — hence this cap; past it, the app is attached with an empty tool list.
 * If the app comes up later anyway, the list is read again and announced (immediately for
 * Claude, starting from the next thread for Codex). This must be shorter than the runtime's
 * connection cap (30 seconds) so that it is this cap that triggers first.
 */
export const TOOL_LIST_WAIT_MS = 15_000

/**
 * How long the outcome of a call that was already handed back early is kept (A-5, "long-running
 * calls"). An agent normally asks again with `run_status` within a few minutes. Anything older
 * than this is answered from the record (status and reason) only, without the result body.
 */
export const DETACHED_KEEP_MS = 60 * 60_000
/**
 * A tool the host adds to every app proxy server (A-5) — to check the status and result of a
 * call that was already handed back early.
 *
 * It only reads (`readOnlyHint`) — so no preset ever asks about it (decision 5). If the app has
 * a tool with the same name, the host's own wins: the path for following up on a long-running
 * call must not differ from app to app.
 */
export const RUN_STATUS_TOOL = 'run_status'
