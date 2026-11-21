/*
 * The bounds a session's app calls share with the answers to a linked host's (#1938, links/linked-app-calls.ts) and the
 * caller's side of those (links/linked-apps.ts). A leaf, so both sides import them without a cycle through session-apps.ts.
 */

/**
 * The upper bound on how long we wait when an app whose tool list is unknown has to be spun up to find out. The Claude CLI
 * calls `tools/list` for every attached server as it starts a session, and Codex waits for the bridge's `tools/list` as it
 * starts a thread, so an app that hangs while starting hangs the session. Past this cap the app is attached with an empty tool
 * list; if it comes up later anyway, the list is read again and announced (at once for Claude, from the next thread for Codex).
 * Shorter than the runtime's connection cap (30 seconds), so that it is this cap that triggers first.
 */
export const TOOL_LIST_WAIT_MS = 15_000

/**
 * How long the outcome of a call already handed back early is kept (A-5, "long-running calls"). An agent asks again with
 * `run_status` within a few minutes; anything older is answered from the record (status and reason) only, without the result
 * body.
 */
export const DETACHED_KEEP_MS = 60 * 60_000
/**
 * A tool the host adds to every app proxy server (A-5), to check the status and result of a call already handed back early. It
 * only reads (`readOnlyHint`), so no preset asks about it (decision 5); if the app has a tool of the same name the host's own
 * wins, as following up on a long call must not differ from app to app.
 */
export const RUN_STATUS_TOOL = 'run_status'
