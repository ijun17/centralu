import type { SessionKind } from '@cc/protocol'
import { RESERVED_APP_IDS } from '@cc/protocol'
import type { ToolProfile } from '../apps/contract.js'

/**
 * Which bundle of Centralu's own tools a session gets (#69, #320), as a function of what the session
 * is. The manager asks the same question at creation, at every wake and on every bridge call
 * (`SessionManager.toolProfileOf`); the one rule lives here so those answers cannot drift apart.
 *
 * Everything the rule reads is a fact about the session's row or the person's settings. The tool
 * (Claude or Codex) and the permission preset are deliberately not inputs: the profile is the same
 * under either tool and any preset, and the adapters narrow by the profile they are handed.
 */
export type ToolProfileFacts = {
  kind: SessionKind
  /** null for a session with no project (the orchestrator, a user-folder app's builder) */
  projectId: string | null
  /** The app that created this session (#81): a builder's own app, or the app that asked for an agent (M4 D-1) */
  appId: string | null
  /**
   * This session is that app's builder session (M4 C-3): the app's builder slot points at it. Checked
   * before anything else about an app, so the bundle the session received (`check`) matches the bundle
   * the bridge asks about.
   */
  builder: boolean
  /** Settings' "Let sessions look at other sessions" (#320): the reader set is on unless the person turned it off */
  sessionTools: boolean
}

/**
 * Is this an agent session stood up at an external app's request (M4 D-1): one of the workers an
 * external app owns (`appId`) that is not that app's own builder session. No separate marker exists
 * for this; ownership (`appId`) and the builder slot already say it. A row stamped with a reserved
 * id belongs to the removed control app (#372), never to an external app.
 */
export function isAppAgent(f: Pick<ToolProfileFacts, 'kind' | 'appId' | 'builder'>): boolean {
  return !!f.appId && f.kind === 'worker' && !RESERVED_APP_IDS.includes(f.appId) && !f.builder
}

/**
 * Does this ordinary session get the light, read-only set (#320)? On unless the person turned it off
 * in Settings, and never for an agent session an app stood up (M4 D-1): that agent hands its answer
 * back to the app, so reading the project's conversations would carry them out to an app that was
 * never given them (the same reason it gets no apps, `appsFor`).
 *
 * The schemas are attached when the session starts, like every other bundle; turning the setting off
 * stops the calls at once (`readerToolsFor` and the bridge both ask again) and takes the schemas away
 * the next time the session starts.
 */
export function readsOwnProject(f: ToolProfileFacts): boolean {
  return f.kind === 'worker' && !!f.projectId && !isAppAgent(f) && f.sessionTools
}

/**
 * The profile this session gets, or null for no tools. The orchestrator and a coordinator (#80) are
 * told apart by their kind; among workers the builder is checked before the reader, and an app's
 * agent and a session outside a project get nothing.
 */
export function toolProfileFor(f: ToolProfileFacts): ToolProfile | null {
  if (f.kind === 'orchestrator') return 'orchestrator'
  if (f.kind === 'coordinator') return 'scoped'
  if (f.builder) return 'builder'
  return readsOwnProject(f) ? 'reader' : null
}

/**
 * What decides a session's code intelligence (#686): whether it is a child, and the caller's choice for it.
 */
export type CodeIntelligenceFacts = Pick<ToolProfileFacts, 'kind' | 'appId' | 'builder'> & {
  /** The session that started it with start_agent (#561), or the requester of a fork (#677) */
  askedBy: string | null
  /** The session whose conversation it copies (#677) */
  forkedFrom: string | null
  /** start_agent's `lsp`; absent when the caller did not choose */
  lsp?: boolean
}

/**
 * Is this a child session: one an agent or an app started, not the person (#686)? A start_agent child (`askedBy`), a
 * fork of a busy session (`forkedFrom`), and an agent an app asked for (`isAppAgent`).
 */
export function isChildSession(f: CodeIntelligenceFacts): boolean {
  return !!f.askedBy || !!f.forkedFrom || isAppAgent(f)
}

/**
 * Whether this session starts with its code intelligence (the language servers its CLI's plugins declare, LSP) turned
 * off (#686, owner decision 2026-10-15). Decided once, when the session is created, and kept for every wake.
 *
 * Each child with code intelligence may run its own language server: `tsserver` measured 0.5–1.1 GB per child in this
 * monorepo, about twice the CLI itself. Most children's tasks (research, docs, small fixes, tests) do well with search
 * and a final typecheck, so a child starts without it unless its caller asks (`lsp: true`, for refactors and large
 * cross-file changes). The caller chooses per task; Centralu does not guess the kind of task from its words.
 *
 * Sessions the person starts keep the person's own setting, whatever they are; so does the orchestrator. Only the
 * adapter knows what code intelligence is for its CLI (Claude: the plugins that declare `lspServers`); an adapter whose
 * CLI starts no language server (Codex) has nothing to turn off.
 */
export function codeIntelligenceOff(f: CodeIntelligenceFacts): boolean {
  return isChildSession(f) && f.lsp !== true
}

/**
 * A session created without code intelligence (#686, `codeIntelligenceOff`): `off`. Decided once at creation and read on
 * every wake, so a child keeps what it started with, and a session made before this build keeps the person's setting.
 * A setting rather than a column: it only matters to the adapter's launch, and needs no migration.
 */
export const codeIntelligenceKey = (sessionId: string) => `code_intelligence:${sessionId}`

/**
 * Where each bundle comes from. The orchestrator and the builder share one object (the builder's
 * profile blocks everything but `check` through `profileAllows`); a coordinator's object sees only
 * its members; the reader's object refuses directing calls.
 */
export type ToolBundleSources<T> = {
  orchestrator: () => T
  scoped: (scopeSessionIds: string[]) => T
  reader: () => T
}

/** The tool bundle that goes with a profile; undefined when the session has no profile. */
export function toolBundleFor<T>(profile: ToolProfile, scopeSessionIds: string[] | null | undefined, sources: ToolBundleSources<T>): T
export function toolBundleFor<T>(
  profile: ToolProfile | null | undefined,
  scopeSessionIds: string[] | null | undefined,
  sources: ToolBundleSources<T>,
): T | undefined
export function toolBundleFor<T>(
  profile: ToolProfile | null | undefined,
  scopeSessionIds: string[] | null | undefined,
  sources: ToolBundleSources<T>,
): T | undefined {
  switch (profile) {
    case 'orchestrator':
    case 'builder':
      return sources.orchestrator()
    case 'scoped':
      return sources.scoped(scopeSessionIds ?? [])
    case 'reader':
      return sources.reader()
    default:
      return undefined
  }
}
