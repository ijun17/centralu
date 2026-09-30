import type { z } from 'zod'
import type { AppId, NormalizedEvent, ToolName } from '@cc/protocol'
import { APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, newAppIdProblem, serverNameProblem } from '@cc/protocol'

/*
 * The runtime's central set of types is **born here** (#97).
 *
 * Previously, sessions/orchestrator-tools.ts defined these and this file just re-exported them. That
 * left the source of truth for "what can an app call" sitting with a passenger (the orchestrator)
 * riding on top of the layer that hosts apps, rather than with that layer itself — delete that
 * passenger, and the runtime would fail to compile. The orchestrator is one of the runtime's callers,
 * not its owner.
 */

/**
 * The set of tools a session receives (#69). The orchestrator gets all of them, the worktree manager
 * gets a subset, a coordination session gets the three within its scope, and an app's building
 * session (M4 C-3) gets exactly one, `check`, to check its own app.
 */
export type ToolProfile = 'orchestrator' | 'manager' | 'scoped' | 'builder'

/** Whoever called an app tool — sessionId=null means a person (the UI). An app uses this to judge its own permissions */
export type AppToolCaller = { sessionId: string | null; profile: ToolProfile | 'human' }

export type ToolOutput = { text: string; isError?: boolean }

/**
 * The host-side contract for an app (#81) — **one half of the passport.**
 *
 * An app never knows the core exists (more precisely: it reaches it only through the door this file
 * gives), and gets orchestrator tools and its own state through that door alone. The other direction
 * is a single line in the registry — that is the isolation that lets the core stay ignorant of apps
 * and lets an experimental one be ripped out cleanly (not full isolation, but one-way plus
 * ownership).
 *
 * A tool name must always carry the `<id>_` prefix — this is the naming convention a person uses to
 * read where a call came from on its card, but the source of truth for validation is the
 * registration list (orchestrator-tools.ts), not the prefix.
 */
export type HostAppContext = {
  /** A namespaced KV — physically `app:<id>:<key>` in app_settings (precedent: the skills and MCP proposal) */
  kv: {
    get<T>(key: string): T | null
    set(key: string, value: unknown): void
  }
  /** A minimal session lookup for validation and display — read-only, and this is the entirety of what an app knows about a session */
  sessionSummary(id: string): { name: string; state: string; projectId: string | null } | null
  /** The `app_state_changed` broadcast — the UI re-reads it via apps.state (deliberately a coarse-grained event) */
  emitChanged(): void
  /**
   * The primitive for physically creating a session (#80, #81). **This is typed** — a general-purpose
   * session-creation primitive would hand an app the leverage to create a session with arbitrary
   * power (especially seen with #72's generative apps in mind). The app supplies the meaning (the
   * name, the role text), and the core enforces the capability (forcing scope, pinning it).
   */
  sessions: {
    createCoordinator(opts: {
      name: string
      memberSessionIds: string[]
      roleAppend: string
      /** An open-ended name (#74) — the receiving side (manager.createCoordinator) originally typed this as ToolName */
      tool: ToolName
      model?: string
      effort?: string
    }): Promise<{ id: string; name: string }>
  }
}

export type HostAppModule = {
  /** An open-ended string, the same as the UI's half (M4 P-1) — an external app must also appear on the same registry */
  id: AppId
  tools?: {
    /** Which profiles see these tools — never a worker, under any circumstances */
    profiles: readonly ToolProfile[]
    /** If a def has its own profiles, it overrides the group default — needed by an app (control) whose tools each want a different scope */
    defs: readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; profiles?: readonly ToolProfile[] }[]
    run(ctx: HostAppContext, name: string, args: Record<string, unknown>, caller: AppToolCaller): Promise<ToolOutput>
  }
  /**
   * Observing events (#80's checkpoint, contract growth anticipated by #81) — **the rule is the
   * app's opinion, observation itself is the physical mechanism.** Every event the host broadcasts
   * flows to every enabled app. Kept lightweight since this is a synchronous call: never do heavy
   * work here, and a failure is swallowed and logged by the host. `app_state_changed` never comes
   * back to the app that produced it (to prevent a loop).
   */
  observe?(ctx: HostAppContext, event: NormalizedEvent): void
  /**
   * Called once at startup — returns **the ids of the sessions this app has already created**
   * (requested by the user, 2026-09-09).
   *
   * Ownership (appId) is now recorded on a session's row, but a session created before that column
   * existed has it empty. **Only the app knows** which sessions belong to it (only the app knows the
   * shape of its own documents) — so the app states it and the core records it. The core still never
   * learns the meaning of it.
   */
  claimSessions?(ctx: HostAppContext): readonly string[]
}

/**
 * The name of the orchestrator MCP server.
 *
 * **This is both the name shown on screen and the key trust is checked against** — it shows up on a
 * tool call card as `mcp__centralu__list_sessions`, and both the claude adapter's approval exception
 * and codex's elicitation acceptance judge trust by this same name.
 *
 * Why this lives in exactly one place: there used to be one literal copy each in the claude and codex
 * adapters, and the manager, which is precisely the thing that needs to validate a proposed server
 * name, could import neither (importing an adapter drags its SDK along). With the key duplicated, a
 * fix to only one copy is an accident waiting to happen — it is written once here, and everything
 * else imports it (#93).
 *
 * **Why it lives here, in the app contract (M4 A-1)**: it used to sit next to the orchestrator's tool
 * definitions. An external app's id has to follow the same rule (the server name attached to a
 * session is `app-<id>`), but the app runtime cannot import the sessions layer — if the rule stayed
 * with a passenger (the orchestrator), the runtime would end up with two copies of it. This is the
 * same direction #97 moved the central types in, into this file.
 *
 * **The value and its validation moved once more, into `app-id.ts` in `@cc/protocol` (M4 C-1).** The
 * "new app" dialog has to validate the id it builds from the name before creating it, and that
 * package is the only place the UI can reach. This file only attaches the host's name and the reason
 * text an agent or a log reads — validation travels together with the dialog.
 */
export const ORCHESTRATOR_MCP_NAME = RESERVED_NAME_PREFIX

/**
 * Whether a proposed MCP server name is safe to use (#93). Returns a reason a person can read if it
 * is not, or null if it is fine.
 *
 * **This is blocked at the point where the name comes in.** An approved server's name becomes a tool
 * prefix, and that tool prefix is what the approval exception judges. Two holes found by measurement:
 *
 *   centralu      **completely replaced** the in-process orchestrator server (the approved server
 *                 expands after the built-in entry — the same key ends up belonging to someone else)
 *   centralu__pw  the tool name became `mcp__centralu__pw__*`, which passed the prefix check →
 *                 skipped canUseTool entirely
 *
 * So there are two layers of defense here. Excluding underscores from the character rule makes `__`
 * impossible to form (closing the second hole), and the reserved-word check keeps the name itself
 * from being taken (closing the first). Checking reserved words first means that even if the
 * character rule is loosened later, this particular check still survives.
 */
/**
 * The prefix for the server name an external app attaches to a session (M4 A-5) — app `notes` is
 * `app-notes` in a session, and its tools show up as `mcp__app-notes__<tool>`.
 *
 * Why the prefix is kept separate: an app's id and a proposed MCP server name follow the same
 * character rule (below), so attaching an app as bare `notes` would fight over the same slot as a
 * `notes` server the person has already approved.
 */
export const APP_MCP_PREFIX = APP_SERVER_PREFIX

export const appMcpServerName = (appId: string): string => `${APP_MCP_PREFIX}${appId}`

export function mcpServerNameError(name: string): string | null {
  // Reserved words are checked first — the order of validation is enforced by protocol's serverNameProblem
  switch (serverNameProblem(name)) {
    case 'reserved':
      return `"${ORCHESTRATOR_MCP_NAME}"로 시작하는 이름은 이 앱이 쓰는 이름입니다 — 다른 이름으로 제안하세요`
    case 'shape':
      return '이름은 소문자·숫자·하이픈으로 32자 이내여야 합니다 (밑줄은 도구 이름의 칸막이라 쓸 수 없습니다)'
    case null:
      return null
  }
}

/**
 * Validation for a MCP server name **as proposed** to a person — adds a ban on the `app-` prefix to
 * the rules above (M4 A-5).
 *
 * This does not ban the prefix from an app's own id (an app called `app-store` attaches as
 * `app-app-store`, so it never collides). What is banned is a proposed server: an approved `app-notes`
 * server would land in the same slot as app `notes`'s own proxy server. An adapter expands the app
 * afterward so the app wins, but that means a server the person approved silently disappears. And a
 * tool under an `app-` name is a slot that can skip approval through an app's read-only annotation —
 * that slot must belong only to an app the runtime itself knows about. So this is blocked at the
 * point where the name comes in.
 */
export function proposedMcpServerNameError(name: string): string | null {
  const base = mcpServerNameError(name)
  if (base) return base
  if (newAppIdProblem(name) === 'server-prefix') {
    return `"${APP_MCP_PREFIX}"로 시작하는 이름은 외부 앱이 세션에 붙는 이름입니다 — 다른 이름으로 제안하세요`
  }
  return null
}

