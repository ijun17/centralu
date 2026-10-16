import { bridgePath } from './bridge-path.js'
import { ORCHESTRATOR_MCP_NAME } from '../../sessions/orchestrator-tools.js'
import type { CreateSessionOpts } from '../contract.js'
import { APP_CALL_WAIT_MS, APP_STARTUP_TIMEOUT_SEC, appApprovalModeFor, CODEX_TOOL_TIMEOUT_SEC, repoFilesConfig, type AppApprovalMode } from './launch-config.js'

/** What the thread's servers read of the session they belong to */
export type ServersHost = {
  readonly sessionId: string
  readonly opts: CreateSessionOpts
  /** A request on the session's connection */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  threadId(): string | null
}

/**
 * The MCP servers a Codex thread loads (FR-11, M4 A-5, #382): Centralu's bridge and one bridge per attached app, the
 * approval mode they get, which of them failed to start, and the app calls they carry.
 */
export class CodexServers {
  /** App servers loaded onto this thread through the bridge — only elicitations under those names go to our cards */
  appServers = new Set<string>()
  /** Whether this thread was given Centralu's own server — only then is an elicitation under that name ours to accept (#382) */
  ownServer = false
  /** The approval mode the app bridges on this thread were given, or null when it has none (#382, `checkAppMode`) */
  private appModeLoaded: AppApprovalMode | null = null
  /**
   * MCP servers whose failed start was already said (#304). Codex tries a failing server twice on one thread start
   * (measured, codex-cli 0.160.0), and one line per server is enough; a server that starts again may fail again later.
   */
  private mcpFailed = new Set<string>()

  constructor(private readonly host: ServersHost) {}

  /**
   * The MCP settings loaded onto the thread — start and resume use **the exact same assembly**
   * (so nothing is missing on resume).
   *
   * There are two:
   *   1. The bridge for Centralu's own tools (FR-11). Since #320 every ordinary session gets it
   *      too (the reader set), so a Codex session starts one small node process for it (about
   *      40 MB resident, measured idle) unless the person turned the set off in Settings.
   *   2. The bridge for an external app (M4 A-5) — one per app. This is only produced **for a
   *      session that has an app attached**: a session with neither starts no bridge. An MCP
   *      server the person approved (propose_mcp_server) also becomes a user-folder app and
   *      arrives here (A-7). It used to be loaded raw, but Codex's elicitation asking whether to
   *      use that server's tools was likely being rejected by us (we only accept `ours`), so it
   *      probably never ran even once (plan "to confirm separately" 2). Tool approval for an app
   *      bridge goes to our own approval cards.
   *
   * The app bridge is an stdio process that Codex starts (one of the three in plan S-3). HTTP
   * (`url`) never received a single request in 0.147.0, and we could not re-check in 0.153.4.
   * The bridge is the same file as the orchestrator's (they are split by `CC_APP_SERVER`).
   */
  /**
   * The approval policy the person's own Codex settings resolve to, for an app bridge under normal (#382, decision
   * 1). Asked of Codex itself (`config/read`), so profiles, managed layers and the person's own file are merged the
   * way Codex merges them.
   *
   * Which layers count follows what this thread will load. Measured (codex-cli 0.160.0, a scratch `CODEX_HOME`, the
   * person's `approval_policy` and a repository's `.codex/config.toml` set to opposite values, 2026-10-11):
   *
   *   Codex's trust for the folder   config/read {}   config/read {cwd}   thread/start (no per-thread trust)
   *   trusted                        person's         repository's        repository's
   *   untrusted                      person's         person's            person's
   *   unset                          person's         person's            person's
   *
   * and with `repoFilesConfig`'s per-thread `untrusted` the thread reports the person's in every row. So a session
   * whose repository files are kept out (an untrusted project, the orchestrator and coordinators) reads without a
   * folder, and a trusted project's session reads from its folder, as Claude's normal reads the project's settings
   * there. Should the two still differ (a layer this read does not see), the thread's own report is compared
   * afterwards (`checkAppMode`) and the difference logged. A Codex without `config/read`, or one that fails, keeps
   * `writes`.
   */
  async personsApprovalPolicy(): Promise<unknown> {
    return (await this.personsConfig()).approval_policy ?? null
  }

  async personsConfig(): Promise<Record<string, unknown>> {
    const projectFiles = Object.keys(repoFilesConfig(this.host.opts)).length === 0
    try {
      const res = await this.host.request<{ config?: Record<string, unknown> }>('config/read', projectFiles ? { cwd: this.host.opts.cwd } : {})
      return res?.config ?? {}
    } catch {
      return {}
    }
  }

  /**
   * The thread says which policy it runs under (`approvalPolicy` in the start and resume responses). If that is not
   * the one the app bridges were set for, the apps on this thread ask or refuse differently from the person's policy
   * until the next start; said in the log so it can be found (#382).
   */
  checkAppMode(res: Record<string, unknown> | undefined): void {
    if (this.appModeLoaded === null || this.host.opts.permissionPreset !== 'normal') return
    const policy = res?.approvalPolicy
    if (policy === undefined) return
    const expected = appApprovalModeFor('normal', policy)
    if (expected !== this.appModeLoaded) {
      console.error(
        `[codex] ${this.host.sessionId.slice(0, 8)} app tools were set to ${this.appModeLoaded}, but the thread runs approval policy ${JSON.stringify(policy)}`,
      )
    }
  }

  async mcpConfig(): Promise<Record<string, unknown>> {
    const bridge = this.host.opts.orchestratorBridge
    const servers: Record<string, unknown> = {}
    const orchestrator = !!(this.host.opts.orchestratorTools && bridge)
    this.ownServer = orchestrator
    if (orchestrator) {
      servers[ORCHESTRATOR_MCP_NAME] = {
        command: process.execPath,
        args: [bridgePath()],
        env: { CC_HOST_URL: bridge!.url, CC_BRIDGE_TOKEN: bridge!.token, CC_SESSION_ID: this.host.opts.sessionId },
        /*
         * Our own tools are never asked about, under any preset — the same as Claude, where they
         * skip canUseTool (isOrchestratorTool). Without this, auto (`approvalPolicy: never`) made
         * Codex refuse every one of them on its own: "MCP tool call requires approval, but approval
         * policy is never" (measured, codex-cli 0.160.0, #320). Under safe and normal the
         * elicitation it raised was answered `accept` by us anyway (onServerRequest, `ours`).
         */
        default_tools_approval_mode: 'approve',
        // Said, not assumed (the app bridges' reason above): ask_project's "still working" at 240 s must beat it (#371)
        tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
      }
    }
    const apps = this.host.opts.apps
    const attached = apps?.current() ?? []
    this.appServers = new Set()
    this.appModeLoaded = null
    if (apps && bridge && attached.length > 0) {
      /*
       * Read the tool list first — a read-only tool has to be written per tool for even safe to
       * not ask about it. An app we do not already know is started here to read it (bounded).
       * A session with no attached app never reaches this line.
       */
      const lists = await Promise.all(attached.map((a) => (a.tools ? Promise.resolve(a.tools) : apps.tools(a.server))))
      const mode = appApprovalModeFor(this.host.opts.permissionPreset, this.host.opts.permissionPreset === 'normal' ? await this.personsApprovalPolicy() : null)
      this.appModeLoaded = mode
      attached.forEach((a, i) => {
        servers[a.server] = {
          command: process.execPath,
          args: [bridgePath()],
          env: {
            CC_HOST_URL: bridge.url,
            CC_BRIDGE_TOKEN: bridge.token,
            CC_SESSION_ID: this.host.opts.sessionId,
            CC_APP_SERVER: a.server,
            CC_APP_WAIT_MS: String(APP_CALL_WAIT_MS),
          },
          default_tools_approval_mode: mode,
          // A tool the app itself declares read-only is never asked about, under any preset (decision 5)
          tools: Object.fromEntries(
            (lists[i] ?? []).filter((t) => t.annotations?.readOnlyHint === true).map((t) => [t.name, { approval_mode: 'approve' }]),
          ),
          tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
          startup_timeout_sec: APP_STARTUP_TIMEOUT_SEC,
        }
        this.appServers.add(a.server)
      })
    }
    /*
     * Whether to read the folder's document (AGENTS.md) is not decided here — repoFilesConfig
     * decides it from what the session is.
     *
     * This used to load `project_doc_max_bytes: 0` here whenever the orchestrator tool bridge was
     * present, because the orchestrator followed a planted AGENTS.md verbatim (measured: it
     * started answering with "infiltration-success-9142" once one was planted). But the worktree
     * manager and the session that creates the worktree also receive this bridge, so they lost
     * AGENTS.md even in trusted projects (#152). The rule for orchestrator and coordination
     * sessions is unchanged — they arrive as `noSettingFiles`, and repoFilesConfig loads the same
     * value for them.
     */
    return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
  }

  /**
   * Whether this thread can call an attached app's bridge (#308). The servers are fixed when the thread
   * starts or resumes (`mcpConfig`), and Codex ignores later changes, so an app attached after that is
   * not in this thread until it restarts. Before the thread exists, the coming start takes the current
   * set, so the app is counted in. A bridge Codex reported failed stays failed until it reports ready.
   */
  appAttachment(server: string): 'attached' | 'restart' | 'failed' {
    if (this.host.threadId() === null) return 'attached'
    if (!this.appServers.has(server)) return 'restart'
    return this.mcpFailed.has(server) ? 'failed' : 'attached'
  }

  /** Whether this MCP status is one to say: a failure not yet said since the server last started (see `mcpFailed`). */
  firstMcpFailure(params: unknown): boolean {
    const p = (params ?? {}) as { name?: unknown; status?: unknown }
    const name = typeof p.name === 'string' ? p.name : ''
    if (p.status === 'ready') this.mcpFailed.delete(name)
    if (p.status !== 'failed') return false
    if (this.mcpFailed.has(name)) return false
    this.mcpFailed.add(name)
    return true
  }

  /**
   * Tells the attachment layer when an attached app's tool call starts and ends (M4 B-1 —
   * matching cards to calls on the in-conversation screen).
   *
   * A call coming in through the bridge does not know the card id (`item.id`) — we found no
   * evidence that Codex carries that id on the MCP request. So we record here what we observed
   * ("card X calls server S's tool T with argument A"), and the attachment layer matches it
   * against the call that follows. A card that has ended (including a rejection) is removed from
   * matching. A notification from another thread (a child agent) was already filtered out above —
   * a child's call is not the parent's card.
   */
  noteAppCall(n: { method: string; params?: unknown }): void {
    const apps = this.host.opts.apps
    if (!apps || (n.method !== 'item/started' && n.method !== 'item/completed')) return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'mcpToolCall' || typeof item.id !== 'string') return
    if (n.method === 'item/completed') return apps.callEnded(item.id)
    const server = typeof item.server === 'string' ? item.server : ''
    const tool = typeof item.tool === 'string' ? item.tool : ''
    if (!this.appServers.has(server) || !tool) return
    apps.noteCall(item.id, server, tool, item.arguments ?? (item.invocation as { arguments?: unknown } | undefined)?.arguments ?? {})
  }
}
