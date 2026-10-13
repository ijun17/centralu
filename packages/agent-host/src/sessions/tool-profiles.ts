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
  /** Settings' "Let sessions look at their own project" (#320): the reader set is on unless the person turned it off */
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
