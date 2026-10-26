import type { LaunchDemands, SessionInfo, ToolName } from '@cc/protocol'
import { ORCHESTRATOR_DEMANDS } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import { orchestratorHome } from './orchestrator-home.js'
import { OrchestratorProposals, type ProposalOutcome } from './orchestrator-proposals.js'
import { notAToolText, profileAllows, runOrchestratorTool } from './orchestrator-tools.js'
import type { RestartHost } from './restart-policy.js'
import type { SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import { unfitError } from './tool-fit.js'

/**
 * What the orchestrator's slot reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type OrchestratorSlotHost = Pick<DelegationHost, 'meta' | 'store' | 'emit' | 'firstTool' | 'createSession' | 'rename'> &
  Pick<SessionTrashHost, 'appsHub'> &
  Pick<RestartHost, 'restartSession'> &
  Pick<SessionStartsHost, 'tools'> & {
    /** Why a tool cannot run a session that demands this, or null (`ToolRegistry.refusal`) */
    refusal: (tool: ToolName, demands: LaunchDemands) => string | null
  }

/**
 * The app's one central orchestrator: made on its first question, with the tool chosen for it before it exists; the
 * MCP-server and skill proposals it makes and the person answers; and the bridge's door to its tools (the Codex path).
 * Moved out of the session manager as it was (#1143); what it reaches of the manager is `OrchestratorSlotHost`.
 */
export class OrchestratorSlot {
  /** The orchestrator's MCP-server and skill proposals and its approved skills (#71, M4 A-7) */
  readonly proposals: OrchestratorProposals

  constructor(private readonly host: OrchestratorSlotHost) {
    this.proposals = new OrchestratorProposals(
      host.store.settings,
      () => this.host.appsHub?.rt,
      // The manager wraps its `emit` after its modules are made; the callback looks it up when a list changes, not now
      () => this.host.emit({ type: 'orchestrator_proposals_changed' }),
    )
  }

  /** MCP server proposals waiting on the person's approval */
  mcpProposals(): ReturnType<OrchestratorProposals['mcpProposals']> {
    return this.proposals.mcpProposals()
  }

  /** Skill proposals waiting on the person's approval (#71) */
  skillProposals(): ReturnType<OrchestratorProposals['skillProposals']> {
    return this.proposals.skillProposals()
  }

  /** Skills that have been approved and loaded into the orchestrator's role prompt (#71) */
  orchestratorSkills(): ReturnType<OrchestratorProposals['orchestratorSkills']> {
    return this.proposals.orchestratorSkills()
  }

  /** The person's answer to a skill proposal (#71) — if approved, it is saved and the orchestrator is
   * restarted */
  async resolveSkillProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveSkillProposal(name, approve))
  }

  /** Deletes a skill — the orchestrator is restarted so the deleted skill leaves its prompt */
  async deleteOrchestratorSkill(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.deleteOrchestratorSkill(name))
  }

  /** Restarts the orchestrator if it is alive — the shared path for reflecting a skill or MCP change
   * immediately */
  private async restartOrchestrator(): Promise<void> {
    const orch = [...this.host.meta.values()].find((m) => m.kind === 'orchestrator')
    if (orch) await this.host.restartSession(orch.id, 'instructions').catch(() => {})
  }

  /** The person's answer to an MCP server proposal — if approved, it becomes a user-folder app and the
   * orchestrator is restarted (OrchestratorProposals.resolveMcpProposal) */
  async resolveMcpProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveMcpProposal(name, approve))
  }

  /** Restarts the orchestrator when a proposal answer asks for it — the change is already saved by then */
  private async afterProposal({ restart, ...result }: ProposalOutcome): Promise<{ ok: boolean; error?: string }> {
    if (restart) await this.restartOrchestrator()
    return result
  }

  /**
   * A tool execution called through the bridge (the Codex path).
   *
   * **Only the orchestrator itself can call this.** The bridge is a separate process, so anyone
   * holding its token could call anything at all — leaving that door open to let one session instruct
   * another session that is not its own would turn access scope into a promise instead of something
   * structurally guaranteed.
   */
  async runOrchestratorTool(sessionId: string, name: string, args: Record<string, unknown>) {
    const m = this.host.meta.get(sessionId)
    const { profile, tools } = m ? this.host.tools.toolChoice(m) : { profile: null, tools: () => undefined }
    if (!m || !profile) {
      throw rpcError('Only the orchestrator can use this tool')
    }
    /*
     * Narrowing only what is exposed still lets anyone who knows the name just call it anyway (#69) —
     * the bridge is a separate process and can ask for anything at all with just the token. The same
     * check is made again on the execution side too.
     */
    if (!profileAllows(profile, name)) {
      throw rpcError(notAToolText(profile, name))
    }
    return runOrchestratorTool(tools()!, name, args, { sessionId, profile })
  }

  /**
   * Returns it if it exists, and **never creates one** if it does not (#63).
   *
   * Once onboarding started showing the orchestrator screen first, "opening the screen" stopped
   * meaning "creating the process". This only ever asks — the actual creation happens inside
   * orchestrator(), the moment the first question is sent. Creating it before that would spin up a
   * tool process on behalf of someone who never even asked for it.
   */
  orchestratorPeek(): SessionInfo | null {
    const known = this.host.store.sessions.orchestratorId()
    return known ? (this.host.meta.get(known) ?? null) : null
  }

  /**
   * The tool the central orchestrator runs on (#63, the card choice on the onboarding screen).
   *
   * **Only settings for before a session exists.** Because there is a gap between choosing and
   * actually creating it (clicking the card -> ... at some point later ... -> the first question),
   * the choice has to be recorded somewhere, and since this is a property of the install itself,
   * app_settings is the right place for it. Once it has actually been created, switching agents in the
   * session's own settings takes over — this value is never read again after that.
   */
  configureOrchestrator(tool: ToolName): void {
    // Refused as its launch would be (#1562 review): a choice saved here is the orchestrator every window opens
    const refused = this.host.refusal(tool, ORCHESTRATOR_DEMANDS)
    if (refused) throw unfitError(refused)
    this.host.store.settings.setAppSetting('orchestrator_tool', tool)
  }

  /** The orchestrator being created (#839): a second ask while it is made waits on this one, never makes another */
  private orchestratorCreating: Promise<SessionInfo> | null = null

  /**
   * The app's one and only orchestrator. Created on the spot if none exists.
   *
   * **Only comes into existence when called.** Creating it ahead of time when the app is turned on
   * would leave a session nobody ever uses holding onto a tool process — too expensive a price just to
   * turn on the control tower.
   *
   * Returned as-is even if its process is dead. Bringing it back to life is send()'s own job (FR-10),
   * and reviving it here would mean a tool process comes up just from drawing the sidebar.
   */
  async orchestrator(): Promise<SessionInfo> {
    const known = this.host.store.sessions.orchestratorId()
    if (known) {
      const m = this.host.meta.get(known)
      if (m) return m
      // The id remains but the session is gone — the marker alone is cleared, and a new one is created
    }
    if (this.orchestratorCreating) return this.orchestratorCreating
    const creating = this.createOrchestrator().finally(() => {
      if (this.orchestratorCreating === creating) this.orchestratorCreating = null
    })
    this.orchestratorCreating = creating
    return creating
  }

  private async createOrchestrator(): Promise<SessionInfo> {

    /*
     * The tool follows the choice made on the onboarding screen (configureOrchestrator) — hardcoding
     * 'claude' created a contradiction where someone with only Codex installed could pass through
     * onboarding ("Codex is ready") and still be unable to open the orchestrator (#63). The wiring on
     * the Codex side (the stdio bridge) was already laid down and measured by the project orchestrator (#13).
     */
    const configured = this.host.store.settings.appSetting('orchestrator_tool')
    const info = await this.host.createSession({
      projectId: null,
      // The marker is born together with the session — stamping it separately would leave a window with no
      // marker at all
      kind: 'orchestrator',
      cwd: orchestratorHome(),
      tool: this.host.firstTool(configured),
      permissionPreset: ORCHESTRATOR_DEMANDS.permissionPreset,
    })
    // Kept as a name the person set, so the auto-name (FR-18) never overwrites it with the first prompt
    this.host.rename(info.id, 'Orchestrator')
    return this.host.meta.get(info.id)!
  }
}
