import type { SessionInfo } from '@cc/protocol'
import type { MailToolArgs } from '../mail/tool.js'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import type { AskProjectFlow } from './ask-project-flow.js'
import type { DelegationFlow, DelegationHost } from './delegation-flow.js'
import type { AgentStartFlow } from './start-agent-flow.js'
import type { WhenAsked } from './asked-gate.js'
import type { SessionAppWiring } from './session-app-wiring.js'
import { toolBundleFor, toolProfileFor, type ToolProfileFacts } from './tool-profiles.js'
import type { UpdatesAsked } from './updates-asked.js'

/**
 * What a session's tool choice reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionToolsHost = Pick<DelegationHost, 'builderRefOf' | 'meta'> & {
  /** The tools given to an orchestrator (FR-11), built over the manager (orchestrator-seat.ts) */
  orchestratorToolsFor: (orchestratorId: string, scopeIds?: string[], ownProject?: boolean, hubView?: boolean) => OrchestratorTools
  updateCentraluAsked: UpdatesAsked['updateCentraluAsked']
  askProject: AskProjectFlow['askProject']
  startAgent: AgentStartFlow['startAgent']
  agentSession: DelegationFlow['agentSession']
  listAgents: DelegationFlow['listAgents']
  requireAppAccess: SessionAppWiring['requireAppAccess']
  /** The `mail` tool of a session (#1347): the mailbox answers, or says it is not there */
  mailTool: (sessionId: string, args: MailToolArgs) => { text: string; isError?: boolean }
  /** The `compact_self` tool of a session (#1451) */
  compactSelf: (sessionId: string, focus?: string) => { text: string; isError?: boolean }
  /** One step of the orchestrator, asked about when a session's request is its turn (#1447) */
  whenAsked: WhenAsked
}

/**
 * The tools a session receives (#69, #320, #428): its profile by the rule in tool-profiles.ts, the bundle that goes
 * with it, and the reader's light set over its own project. Moved out of the session manager as it was; what it
 * reaches of the manager is `SessionToolsHost`.
 */
export class SessionTools {
  constructor(private readonly host: SessionToolsHost) {}

  /**
   * What the profile rule (tool-profiles.ts) reads about this session: its row, and whether its app's builder slot points
   * at it (looked up unless the caller just wrote it).
   */
  private profileFacts(
    m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>,
    builder: boolean = this.host.builderRefOf(m) !== null,
  ): ToolProfileFacts {
    return { kind: m.kind, projectId: m.projectId, appId: m.appId ?? null, builder }
  }

  /**
   * The tool bundle this session receives (#69). null means no tools. The rule is `toolProfileFor`
   * (tool-profiles.ts); creation and every wake hand the adapter the same answer, and the bridge asks
   * here on every call.
   */
  toolProfileOf(sessionId: string): ToolProfile | null {
    const m = this.host.meta.get(sessionId)
    return m ? this.toolChoice(m).profile : null
  }

  /**
   * The one place a session's tools are chosen (#428): its profile by `toolProfileFor`, and the bundle that goes with
   * it, for creation, every wake, every bridge call and `toolProfileOf`. `builder` is passed by a caller that has just
   * read or written the app's builder slot, and looked up otherwise. The bundle is built only when `tools` is called,
   * where the adapter's options are put together.
   */
  toolChoice(
    m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId' | 'scopeSessionIds'>,
    builder?: boolean,
  ): { profile: ToolProfile | null; tools: () => OrchestratorTools | undefined } {
    const profile = toolProfileFor(this.profileFacts(m, builder))
    return { profile, tools: () => this.toolBundleOf(m.id, profile, m) }
  }

  /** The object behind a profile's bundle: the full set, a coordinator's scope, or the reader's view of its own project */
  private toolBundleOf(sessionId: string, profile: ToolProfile | null, m: Pick<SessionInfo, 'scopeSessionIds'>): OrchestratorTools | undefined {
    return toolBundleFor(profile, m.scopeSessionIds, {
      orchestrator: () => this.orchestratorToolsFor(sessionId),
      scoped: (ids) => this.host.orchestratorToolsFor(sessionId, ids),
      reader: () => this.readerToolsFor(sessionId),
    })
  }

  /**
   * The central orchestrator's set, with the root apps it attaches on demand (#1205): `find_apps`, `attach_app` and
   * `detach_app`, which it runs as commands. AppAccess holds it to the user folder's and trusted projects' root apps.
   */
  private orchestratorToolsFor(sessionId: string): OrchestratorTools {
    return {
      ...this.host.orchestratorToolsFor(sessionId),
      ...this.appAndMailTools(sessionId),
      // A session may have asked for the turn the orchestrator is in (#1447): its steps that change something ask the person first
      whenAsked: (call, signal, run) => this.host.whenAsked(sessionId, call, signal, run, (text) => ({ text, isError: true })),
    }
  }

  /**
   * A profile that directs other sessions — every profile but the reader. The reader set (#320)
   * cannot send, so for provenance (#90) its session is still an ordinary worker.
   */
  directs(sessionId: string): boolean {
    const p = this.toolProfileOf(sessionId)
    return p !== null && p !== 'reader'
  }

  /**
   * The light set an ordinary session gets (#320): other sessions, read-only — every project's and the linked
   * machines' from a trusted project, its own project's from an untrusted one (#984).
   *
   * Only the three readers are taken from the reader view; everything that acts is a refusal
   * here, not just a name the profile leaves out. profileAllows already stops both exposure and the
   * bridge's calls, but a read-only seat should not be holding a working sendToSession behind one
   * check — the object itself cannot act.
   */
  private readerToolsFor(sessionId: string): OrchestratorTools {
    const view = this.host.orchestratorToolsFor(sessionId, undefined, true)
    const error = 'This session can only read other sessions'
    const refuse = async () => ({ ok: false, error })
    return {
      updateCentralu: async (action, signal) => this.host.updateCentraluAsked(sessionId, action, signal),
      listSessions: async (opts) => view.listSessions(opts),
      readSession: async (...a) => view.readSession(...a),
      recall: async (...a) => view.recall(...a),
      // The one reach outside its project (#371 part B) — behind the person's consent for the pair, inside askProject
      askProject: async (opts, signal) => this.host.askProject(sessionId, opts, signal),
      // Other agents in its own project (#561) — behind the person's consent, never above this session's preset
      startAgent: async (opts, signal) => this.host.startAgent(sessionId, opts, signal),
      agentSession: async (opts, signal) => this.host.agentSession(sessionId, opts, signal),
      listAgents: async () => ({ ok: true, agents: await this.host.listAgents(sessionId) }),
      // An ordinary session answers through agent_session (#676)
      answerQuestion: async () => ({ ok: false, error: 'Answer it with agent_session, action "answer"' }),
      sendToSession: refuse,
      createSession: refuse,
      updateSessionSettings: refuse,
      proposeMcpServer: refuse,
      proposeSkill: refuse,
      createProject: async () => ({ ok: false as const, error }),
      checkApp: async () => ({ ok: false, text: error }),
      createApp: refuse,
      ...this.appAndMailTools(sessionId),
    }
  }

  /**
   * What both seats share: another project's apps on demand (#371 part A, #1205), the one thing the reader seat may change and only
   * for itself; the mailbox (#1347), whose tool runs as a command; and `compact_self` (#1451)
   */
  private appAndMailTools(sessionId: string): Pick<OrchestratorTools, 'findApps' | 'attachApp' | 'detachApp' | 'mail' | 'compactSelf'> {
    return {
      findApps: async (query) => this.host.requireAppAccess().find(sessionId, query),
      attachApp: async (app) => this.host.requireAppAccess().attach(sessionId, app),
      detachApp: async (app) => this.host.requireAppAccess().detach(sessionId, app),
      mail: (args) => this.host.mailTool(sessionId, args),
      compactSelf: (focus) => this.host.compactSelf(sessionId, focus),
    }
  }
}
