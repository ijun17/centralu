import { bridgePath } from '../bridge-path.js'
import { CENTRALU_MCP_NAME } from '../../sessions/centralu-tools.js'
import type { CreateSessionOpts } from '../contract.js'
import { appCallOf } from '../tool-titles.js'
import { CODEX_TOOL_TIMEOUT_SEC, repoFilesConfig } from './launch-config.js'

/** What the thread's servers read of the session they belong to */
export type ServersHost = {
  readonly sessionId: string
  readonly opts: CreateSessionOpts
  /** A request on the session's connection */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

/**
 * The MCP server a Codex thread loads (FR-11, #382): Centralu's bridge, which of the thread's servers failed to start, the
 * approval policy the thread runs under, and the `app` calls the thread makes through the bridge (#2231: apps are reached
 * through that tool, not a server each).
 */
export class CodexServers {
  /** Whether this thread was given Centralu's own server — only then is an elicitation under that name ours to accept (#382) */
  ownServer = false
  /** The approval policy the thread said it runs under, at its last start or resume (`noteThreadPolicy`) */
  private threadPolicy: unknown = null
  /**
   * MCP servers whose failed start was already said (#304). Codex tries a failing server twice on one thread start
   * (measured, codex-cli 0.160.0), and one line per server is enough; a server that starts again may fail again later.
   */
  private mcpFailed = new Set<string>()

  constructor(private readonly host: ServersHost) {}

  /**
   * The person's own Codex settings as Codex merges them (`config/read`), read without the folder where the session's
   * repository files are kept out (an untrusted project, the Assistant and coordinators: `repoFilesConfig`), so a planted
   * `.codex/config.toml` is not read for them (#382). Measured (codex-cli 0.160.0, a scratch `CODEX_HOME`, the person's
   * `approval_policy` and a repository's `.codex/config.toml` set to opposite values, 2026-10-11): `config/read {}` gives
   * the person's layers only, and with `cwd` adds the repository's only when Codex trusts that folder, as `thread/start`
   * does. A Codex without `config/read`, or one that fails, reads as no settings.
   */
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
   * The thread says which policy it runs under (`approvalPolicy` in the start and resume responses). Under `normal` and
   * `edits` it is the person's own (#382, decision 1), and `never` is their bypass, under which an app call runs unasked as
   * the CLI's own tools do (#2231, `bypassesApprovals`). Read from the thread rather than worked out, so a layer the host
   * cannot see still counts.
   */
  noteThreadPolicy(res: Record<string, unknown> | undefined): void {
    this.threadPolicy = res?.approvalPolicy ?? null
  }

  /** Whether the thread runs under `approval_policy = "never"` (see `noteThreadPolicy`) */
  policyIsNever(): boolean {
    return this.threadPolicy === 'never'
  }

  /**
   * The MCP settings loaded onto the thread — start and resume use **the exact same assembly** (so nothing is missing on
   * resume): the bridge for Centralu's own tools (FR-11), which since #320 every ordinary session gets too, so a Codex
   * session starts one small node process for it (about 40 MB resident, measured idle). Apps are reached through its
   * `app` tool (#2231), so the set is the same whatever apps come and go, and no thread restarts for them. A server the
   * person approved (propose_mcp_server) becomes a user-folder app (A-7), reached the same way.
   *
   * Whether to read the folder's document (AGENTS.md) is not decided here — repoFilesConfig decides it from what the
   * session is. This used to load `project_doc_max_bytes: 0` whenever the bridge was present, because the Assistant
   * followed a planted AGENTS.md verbatim (measured: it started answering with "infiltration-success-9142" once one was
   * planted). But the worktree manager and the session that creates the worktree also receive this bridge, so they lost
   * AGENTS.md even in trusted projects (#152). The rule for assistant and coordination sessions is unchanged — they
   * arrive as `noSettingFiles`, and repoFilesConfig loads the same value for them.
   */
  async mcpConfig(): Promise<Record<string, unknown>> {
    const bridge = this.host.opts.centraluBridge
    this.ownServer = !!(this.host.opts.centraluTools && bridge)
    if (!this.ownServer) return {}
    return {
      mcp_servers: {
        [CENTRALU_MCP_NAME]: {
          command: process.execPath,
          args: [bridgePath()],
          env: { CC_HOST_URL: bridge!.url, CC_BRIDGE_TOKEN: bridge!.token, CC_SESSION_ID: this.host.opts.sessionId },
          /*
           * Our own tools are never asked about by Codex, under any preset — the same as Claude, where they skip
           * canUseTool (isCentraluToolName). Without this, auto (`approvalPolicy: never`) made Codex refuse every one of
           * them on its own: "MCP tool call requires approval, but approval policy is never" (measured, codex-cli
           * 0.160.0, #320). An `app` call is asked about by the host, at the call, with its arguments (#2231).
           */
          default_tools_approval_mode: 'approve',
          // Said, not assumed: the host answers a long call (ask_project, an app's call) at 240 s, before this cuts it (#371)
          tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
        },
      },
    }
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
   * Tells the attachment layer when an `app` call starts and ends (M4 B-1 — matching cards to calls on the
   * in-conversation screen).
   *
   * A call coming in through the bridge does not know the card id (`item.id`) — we found no evidence that Codex carries
   * that id on the MCP request. So we record here what we observed ("card X calls app A's tool T with arguments …"), and
   * the attachment layer matches it against the call that follows. A card that has ended (including a refusal) is removed
   * from matching. A notification from another thread (a child agent) was already filtered out above — a child's call is
   * not the parent's card.
   */
  noteAppCall(n: { method: string; params?: unknown }): void {
    const apps = this.host.opts.apps
    if (!apps || (n.method !== 'item/started' && n.method !== 'item/completed')) return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'mcpToolCall' || typeof item.id !== 'string') return
    if (n.method === 'item/completed') return apps.callEnded(item.id)
    const server = typeof item.server === 'string' ? item.server : ''
    const tool = typeof item.tool === 'string' ? item.tool : ''
    const call = appCallOf({ server, tool }, item.arguments ?? (item.invocation as { arguments?: unknown } | undefined)?.arguments ?? {})
    if (call) apps.noteCall(item.id, call.app, call.tool, call.args)
  }
}
