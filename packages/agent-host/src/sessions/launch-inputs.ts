import type { SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import { underGrant } from './ask-project.js'
import type { DelegationHost } from './delegation-flow.js'
import type { OrchestratorProposals } from './orchestrator-proposals.js'
import type { RoutedCardsHost } from './routed-cards.js'
import { orchestratorMemory } from './transcript-view.js'
import type { WorktreeHost } from './worktree-sessions.js'

/**
 * What the launch inputs reach of the session manager (#1143), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type LaunchInputsHost = Pick<DelegationHost, 'store' | 'builderRefOf' | 'readGrants'> &
  Pick<RoutedCardsHost, 'apps'> &
  Pick<WorktreeHost, 'projectTrusted'> & {
    /** The orchestrator's approved skills (#71), read for its prompt */
    readonly proposals: Pick<OrchestratorProposals, 'skillsPrompt'>
  }

/**
 * What a session's process is launched with beyond its own settings: the setting files it may read, the paths
 * another project handed back to it, and the orchestrator's memory and skills for its system prompt. Read on every
 * start and wake (session-start.ts). Moved out of the session manager as it was (#1143); what it reaches of the
 * manager is `LaunchInputsHost`.
 */
export class LaunchInputs {
  constructor(private readonly host: LaunchInputsHost) {}

  /**
   * The settings files reachable from this session (M4 decision 3, #92, #152) — decided by **what
   * the session is**. Both creating and waking a session go through this one place.
   *
   *   Orchestrator / coordinator session          No files at all — it has no project, and that
   *                                                folder (orchestratorHome) is one a worker can
   *                                                write to. An instruction arriving through a file
   *                                                is exactly a privilege-escalation path.
   *   Builder session of a user-folder app         Trusted — that folder belongs to the user
   *                                                themselves (decision 3: a user-folder app is trusted)
   *   Agent the user-folder app asked for (D-1)   Only the person's own settings — see the comment below
   *   Builder session of a worker, manager or     Follows that project's trust as-is (same as a
   *   project app; agent the project app          worker under #152)
   *   asked for (D-1)
   *
   * **This is not split by whether the session has orchestrator tools.** It used to be: the adapter
   * split "if it has orchestrator tools, no files at all", but the worktree manager (#69) and
   * builder sessions (C-3) also receive those tools. That meant a builder session of a trusted
   * project could read neither CLAUDE.md nor the user's own ~/.claude (global bypass), so it kept
   * raising an approval card the person had already turned off everywhere else.
   *
   * Whether a session is a builder session is checked via the directory (builderRefOf) — the same
   * check that decides the tool bundle (`builder`). If apps imported from outside ever exist (they
   * do not yet), such an app is not trusted until verified (decision 3) — that is where the split
   * would happen.
   */
  settingFilesFor(
    m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>,
  ): Pick<CreateSessionOpts, 'projectTrusted' | 'noSettingFiles'> {
    if (m.kind === 'orchestrator' || m.kind === 'coordinator') return { projectTrusted: false, noSettingFiles: true }
    if (m.projectId === null && this.host.builderRefOf(m)) return { projectTrusted: true }
    /*
     * Agent a user-folder app asked for (M4 D-1) — receives only the person's own settings
     * (~/.claude, ~/.codex), not files from the folder.
     *
     * That session's text was written by the app, not the person. Its slot, like a coordinator
     * session, is the orchestrator's empty folder (orchestratorHome), which a worker can write to —
     * if it received the CLAUDE.md and settings placed there, an agent running on the app's text
     * would take instructions someone else wrote as if they carried authority. The reason a builder
     * session is trusted (that folder belongs to the person building the app) does not apply here:
     * this session's folder belongs to neither the app nor the person. But giving it no files at all
     * (as with a coordinator session) would mean the person's own rules for every agent (approvals,
     * deny lists) are missing only for agents the app asked for — the one place it would get looser
     * without the person knowing. A project app's version follows that project's trust like a worker
     * (below): that session runs inside the project, and whether it gets the project's settings was
     * already decided by the person through trust.
     */
    if (m.projectId === null && this.host.apps.isAppAgentSession(m)) return { projectTrusted: false }
    return { projectTrusted: this.host.projectTrusted(m.projectId) }
  }

  /** Whether a session may read this path because another project handed it back (#371, `CreateSessionOpts.mayRead`) */
  mayRead(sessionId: string, path: string, cwd: string): boolean {
    const grants = this.host.readGrants.get(sessionId)
    return !!grants && grants.size > 0 && underGrant(path, grants, cwd)
  }

  /** The approved skills as a system prompt section (OrchestratorProposals.skillsPrompt) */
  skillsPrompt(): string {
    return this.host.proposals.skillsPrompt()
  }

  /** A summary of the orchestrator's past conversation for its next system prompt (transcript-view.ts) */
  orchestratorMemory(sessionId: string): string {
    return orchestratorMemory(this.host.store.messages, sessionId)
  }
}
