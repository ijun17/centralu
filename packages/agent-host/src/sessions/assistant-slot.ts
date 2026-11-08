import type { LaunchDemands, SessionInfo, ToolName } from '@cc/protocol'
import { ASSISTANT_DEMANDS, isAssistantKind, ASSISTANT_KIND } from '@cc/protocol'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import { assistantHome } from './assistant-home.js'
import { AssistantProposals, type ProposalOutcome } from './assistant-proposals.js'
import { notAToolText, profileAllows, runCentraluTool } from './centralu-tools.js'
import type { RestartHost } from './restart-policy.js'
import type { SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import { unfitError } from './tool-fit.js'

/**
 * What the Assistant's slot reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type AssistantSlotHost = Pick<DelegationHost, 'meta' | 'store' | 'emit' | 'firstTool' | 'createSession' | 'rename'> &
  Pick<SessionTrashHost, 'appsHub'> &
  Pick<RestartHost, 'restartSession'> &
  Pick<SessionStartsHost, 'tools'> & {
    /** Why a tool cannot run a session that demands this, or null (`ToolRegistry.refusal`) */
    refusal: (tool: ToolName, demands: LaunchDemands) => string | null
    /** The role is the Assistant made now's: unsettled mail sent to the role follows it (mailbox §7.7, D15). Never throws */
    roleMoved?: (toSessionId: string) => void
  }

/**
 * The app's one Assistant: made on its first question, with the tool chosen for it before it exists; the
 * MCP-server and skill proposals it makes and the person answers; and the bridge's door to its tools (the Codex path).
 * Moved out of the session manager as it was (#1143); what it reaches of the manager is `AssistantSlotHost`.
 */
export class AssistantSlot {
  /** The Assistant's MCP-server and skill proposals and its approved skills (#71, M4 A-7) */
  readonly proposals: AssistantProposals

  constructor(private readonly host: AssistantSlotHost) {
    this.proposals = new AssistantProposals(
      host.store.settings,
      () => this.host.appsHub?.rt,
      // The manager wraps its `emit` after its modules are made; the callback looks it up when a list changes, not now
      () => this.host.emit({ type: 'orchestrator_proposals_changed' }),
    )
  }

  /** MCP server proposals waiting on the person's approval */
  mcpProposals(): ReturnType<AssistantProposals['mcpProposals']> {
    return this.proposals.mcpProposals()
  }

  /** Skill proposals waiting on the person's approval (#71) */
  skillProposals(): ReturnType<AssistantProposals['skillProposals']> {
    return this.proposals.skillProposals()
  }

  /** Skills that have been approved and loaded into the Assistant's role prompt (#71) */
  assistantSkills(): ReturnType<AssistantProposals['assistantSkills']> {
    return this.proposals.assistantSkills()
  }

  /** The person's answer to a skill proposal (#71) — if approved, it is saved and the Assistant is
   * restarted */
  async resolveSkillProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveSkillProposal(name, approve))
  }

  /** Deletes a skill — the Assistant is restarted so the deleted skill leaves its prompt */
  async deleteAssistantSkill(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.deleteAssistantSkill(name))
  }

  /** Restarts the Assistant if it is alive — the shared path for reflecting a skill or MCP change
   * immediately */
  private async restartAssistant(): Promise<void> {
    const orch = [...this.host.meta.values()].find((m) => isAssistantKind(m.kind))
    if (orch) await this.host.restartSession(orch.id, 'instructions').catch(() => {})
  }

  /** The person's answer to an MCP server proposal — if approved, it becomes a user-folder app and the
   * assistant is restarted (AssistantProposals.resolveMcpProposal) */
  async resolveMcpProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveMcpProposal(name, approve))
  }

  /** Restarts the Assistant when a proposal answer asks for it — the change is already saved by then */
  private async afterProposal({ restart, ...result }: ProposalOutcome): Promise<{ ok: boolean; error?: string }> {
    if (restart) await this.restartAssistant()
    return result
  }

  /**
   * A tool execution called through the bridge (the Codex path).
   *
   * **Only the Assistant itself can call this.** The bridge is a separate process, so anyone
   * holding its token could call anything at all — leaving that door open to let one session instruct
   * another session that is not its own would turn access scope into a promise instead of something
   * structurally guaranteed.
   */
  async runCentraluTool(sessionId: string, name: string, args: Record<string, unknown>) {
    const m = this.host.meta.get(sessionId)
    const { profile, tools } = m ? this.host.tools.toolChoice(m) : { profile: null, tools: () => undefined }
    if (!m || !profile) {
      throw rpcError('Only the Assistant can use this tool')
    }
    /*
     * Narrowing only what is exposed still lets anyone who knows the name just call it anyway (#69) —
     * the bridge is a separate process and can ask for anything at all with just the token. The same
     * check is made again on the execution side too.
     */
    if (!profileAllows(profile, name)) {
      throw rpcError(notAToolText(profile, name))
    }
    return runCentraluTool(tools()!, name, args, { sessionId, profile })
  }

  /**
   * Returns it if it exists, and **never creates one** if it does not (#63).
   *
   * Once onboarding started showing the Assistant screen first, "opening the screen" stopped
   * meaning "creating the process". This only ever asks — the actual creation happens inside
   * assistant(), the moment the first question is sent. Creating it before that would spin up a
   * tool process on behalf of someone who never even asked for it.
   */
  assistantPeek(): SessionInfo | null {
    const known = this.host.store.sessions.assistantId()
    return known ? (this.host.meta.get(known) ?? null) : null
  }

  /**
   * The tool the Assistant runs on (#63, the card choice on the onboarding screen).
   *
   * **Only settings for before a session exists.** Because there is a gap between choosing and
   * actually creating it (clicking the card -> ... at some point later ... -> the first question),
   * the choice has to be recorded somewhere, and since this is a property of the install itself,
   * app_settings is the right place for it. Once it has actually been created, switching agents in the
   * session's own settings takes over — this value is never read again after that.
   */
  configureAssistant(tool: ToolName): void {
    // Refused as its launch would be (#1562 review): a choice saved here is the Assistant every window opens
    const refused = this.host.refusal(tool, ASSISTANT_DEMANDS)
    if (refused) throw unfitError(refused)
    this.host.store.settings.setAppSetting('orchestrator_tool', tool)
  }

  /** The Assistant being created (#839): a second ask while it is made waits on this one, never makes another */
  private assistantCreating: Promise<SessionInfo> | null = null

  /**
   * The app's one and only assistant. Created on the spot if none exists.
   *
   * **Only comes into existence when called.** Creating it ahead of time when the app is turned on
   * would leave a session nobody ever uses holding onto a tool process — too expensive a price just to
   * turn on the control tower.
   *
   * Returned as-is even if its process is dead. Bringing it back to life is send()'s own job (FR-10),
   * and reviving it here would mean a tool process comes up just from drawing the sidebar.
   */
  async assistant(): Promise<SessionInfo> {
    const known = this.host.store.sessions.assistantId()
    if (known) {
      const m = this.host.meta.get(known)
      if (m) return m
      // The id remains but the session is gone — the marker alone is cleared, and a new one is created
    }
    if (this.assistantCreating) return this.assistantCreating
    const creating = this.createAssistant().then((made) => {
      // The one before it is gone, in the trash or for good: what was sent to the role and is not settled goes to this one, delivered afresh (#1683)
      try {
        this.host.roleMoved?.(made.id)
      } catch (e) {
        console.error(`[mail] the Assistant's mail could not follow its role: ${e instanceof Error ? e.message : String(e)}`)
      }
      return made
    }).finally(() => {
      if (this.assistantCreating === creating) this.assistantCreating = null
    })
    this.assistantCreating = creating
    return creating
  }

  /**
   * #2133: the role's session a build before the rename made is named "Orchestrator". It takes the new name once, at the host's start, so the
   * screen shows the role's name and mail to `orchestrator` is not delivered to it by name (the old address has no alias). Any other name
   * stays; a person who chose "Orchestrator" themselves cannot be told apart and is renamed too. A session name is free text to every build, so the previous release reads the new one
   */
  renameFromOldName(): void {
    const id = this.host.store.sessions.assistantId()
    const m = id ? this.host.meta.get(id) : undefined
    if (m?.name === 'Orchestrator') this.host.rename(m.id, 'Assistant')
  }

  private async createAssistant(): Promise<SessionInfo> {

    /*
     * The tool follows the choice made on the onboarding screen (configureAssistant) — hardcoding
     * 'claude' created a contradiction where someone with only Codex installed could pass through
     * onboarding ("Codex is ready") and still be unable to open the Assistant (#63). The wiring on
     * the Codex side (the stdio bridge) was already laid down and measured by the project assistant (#13).
     */
    const configured = this.host.store.settings.appSetting('orchestrator_tool')
    const info = await this.host.createSession({
      projectId: null,
      // The marker is born together with the session — stamping it separately would leave a window with no
      // marker at all
      kind: ASSISTANT_KIND,
      cwd: assistantHome(),
      tool: this.host.firstTool(configured),
      permissionPreset: ASSISTANT_DEMANDS.permissionPreset,
    })
    // Kept as a name the person set, so the auto-name (FR-18) never overwrites it with the first prompt
    this.host.rename(info.id, 'Assistant')
    return this.host.meta.get(info.id)!
  }
}
