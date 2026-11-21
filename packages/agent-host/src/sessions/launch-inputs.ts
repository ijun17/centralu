import { isAssistantOrCoordinator } from '@cc/protocol'
import type { SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import { underGrant } from './ask-project.js'
import type { DelegationHost } from './delegation-flow.js'
import type { AssistantProposals } from './assistant-proposals.js'
import type { RoutedCardsHost } from './routed-cards.js'
import { assistantMemory } from './transcript-view.js'
import type { WorktreeHost } from './worktree-sessions.js'

/**
 * What the launch inputs reach of the session manager (#1143), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type LaunchInputsHost = Pick<DelegationHost, 'store' | 'builderRefOf' | 'readGrants'> &
  Pick<RoutedCardsHost, 'apps'> &
  Pick<WorktreeHost, 'projectTrusted'> & {
    /** The Assistant's approved skills (#71), read for its prompt */
    readonly proposals: Pick<AssistantProposals, 'skillsPrompt'>
  }

/**
 * What a session's process is launched with beyond its own settings: the setting files it may read, the paths another project
 * handed back to it, and the Assistant's memory and skills for its system prompt. Read on every start and wake
 * (session-start.ts). What it reaches of the manager is `LaunchInputsHost`.
 */
export class LaunchInputs {
  constructor(private readonly host: LaunchInputsHost) {}

  /**
   * The settings files reachable from this session (M4 decision 3, #92, #152), decided by **what the session is**; creating and
   * waking go through this one place. An Assistant or coordinator session gets no files at all: it has no project and its
   * folder (assistantHome) is one a worker can write to, so an instruction arriving through a file is a privilege-escalation
   * path. A builder session of a user-folder app is trusted (that folder is the user's own, decision 3); an agent that app
   * asked for (D-1) gets only the person's own settings (below); a builder of a worker, manager or project app, and an agent a
   * project app asked for, follow that project's trust as a worker does (#152). **Not split by whether the session has Centralu
   * tools:** the worktree manager (#69) and builder sessions (C-3) also receive them, so splitting on that left a builder
   * session of a trusted project reading neither CLAUDE.md nor the user's own ~/.claude (global bypass), and it kept raising an
   * approval card the person had already turned off everywhere else. Whether a session is a builder session is checked via the
   * directory (builderRefOf), the check that decides the tool bundle (`builder`).
   */
  settingFilesFor(
    m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>,
  ): Pick<CreateSessionOpts, 'projectTrusted' | 'noSettingFiles'> {
    if (isAssistantOrCoordinator(m.kind)) return { projectTrusted: false, noSettingFiles: true }
    if (m.projectId === null && this.host.builderRefOf(m)) return { projectTrusted: true }
    /*
     * Agent a user-folder app asked for (M4 D-1): receives only the person's own settings (~/.claude, ~/.codex), not files from
     * the folder. Its text was written by the app, not the person, and its slot, like a coordinator session, is the Assistant's
     * empty folder (assistantHome), which a worker can write to: if it received the CLAUDE.md and settings placed there, an
     * agent running on the app's text would take instructions someone else wrote as if they carried authority. A builder
     * session is trusted because its folder belongs to the person building the app, which does not hold here: this folder
     * belongs to neither the app nor the person. But no files at all (as with a coordinator session) would leave the person's
     * own rules for every agent (approvals, deny lists) missing only for agents the app asked for, the one place it would get
     * looser without the person knowing. A project app's version follows that project's trust like a worker (below): that
     * session runs inside the project, and the person already decided through trust whether it gets the project's settings.
     */
    if (m.projectId === null && this.host.apps.isAppAgentSession(m)) return { projectTrusted: false }
    return { projectTrusted: this.host.projectTrusted(m.projectId) }
  }

  /** Whether a session may read this path because another project handed it back (#371, `CreateSessionOpts.mayRead`) */
  mayRead(sessionId: string, path: string, cwd: string): boolean {
    const grants = this.host.readGrants.get(sessionId)
    return !!grants && grants.size > 0 && underGrant(path, grants, cwd)
  }

  /** The approved skills as a system prompt section (AssistantProposals.skillsPrompt) */
  skillsPrompt(): string {
    return this.host.proposals.skillsPrompt()
  }

  /** A summary of the Assistant's past conversation for its next system prompt (transcript-view.ts) */
  assistantMemory(sessionId: string): string {
    return assistantMemory(this.host.store.messages, sessionId)
  }
}
