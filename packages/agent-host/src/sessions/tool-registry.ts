import type { LaunchDemands, ToolName } from '@cc/protocol'
import { launchRefusal } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { registeredTool } from '../adapters/registry.js'
import type { DelegationHost } from './delegation-flow.js'
import type { QueuedRequestsHost } from './queued-requests.js'

/**
 * What the tool registry reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ToolRegistryHost = Pick<DelegationHost, 'store'> &
  Pick<QueuedRequestsHost, 'projectRow'> & {
    /** The agent tools this host runs, by name: the adapters it was started with */
    readonly adapters: ReadonlyMap<ToolName, AgentAdapter>
  }

/**
 * Which agent tools this host runs, as the rest of the manager asks: the one to use when nothing chose one, a
 * tool's name on screen, its account, and whether it can start a session now. Moved out of the session manager as it
 * was (#1143); what it reaches of the manager is `ToolRegistryHost`.
 */
export class ToolRegistry {
  constructor(private readonly host: ToolRegistryHost) {}

  /**
   * The tool to use when nothing has chosen one — the first registered adapter, or none.
   *
   * A project's `defaultTool` is nullable because only the host knows which tools exist, so
   * a project created before any tool was picked has none. Falling back to a literal
   * `'claude'` here would put a vendor name back into code that is meant not to know any.
   */
  firstTool(preferred?: ToolName | null): ToolName | null {
    return registeredTool(this.host.adapters, preferred)
  }

  /** A tool's display name, from whichever adapter owns it — falls back to the bare id. */
  toolLabel(tool: ToolName): string {
    return this.host.adapters.get(tool)?.descriptor.label ?? tool
  }

  /** Which account `tool` is logged in to here, as the hub compares it with a linked machine's (#726) */
  async accountFor(tool: ToolName): Promise<{ loggedIn: boolean | null; fingerprint: string | null }> {
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.account) return { loggedIn: null, fingerprint: null }
    return adapter.account().catch(() => ({ loggedIn: null, fingerprint: null }))
  }

  /**
   * The default agent tool for this scope — a project's default tool if it has one, or the
   * orchestrator's own tool if there is no project (a user-folder app). A builder session (C-2) and an
   * agent an app asked for (D-1) both use this same rule.
   */
  defaultToolFor(projectId: string | null): ToolName | null {
    if (projectId !== null) {
      const project = this.host.projectRow(projectId)
      return this.firstTool(project?.defaultTool)
    }
    return this.firstTool(this.host.store.settings.appSetting('orchestrator_tool'))
  }

  /**
   * Why `tool` cannot run a session that demands this (`launchRefusal`), or null: the one rule, for every path that puts
   * a tool on a session (`tool-fit.ts`). A tool this host does not run is `toolProblem`'s to say
   */
  refusal(tool: ToolName, demands: LaunchDemands): string | null {
    const adapter = this.host.adapters.get(tool)
    return adapter ? launchRefusal(adapter.capabilities, adapter.descriptor.label, demands) : null
  }

  /** Why `tool` cannot start a session here now (not registered, not installed, not logged in), or null when it can */
  async toolProblem(tool: string): Promise<string | null> {
    const adapter = this.host.adapters.get(tool)
    if (!adapter) return `${JSON.stringify(tool)} is not a tool Centralu runs here`
    const d = await adapter.detect().catch((e: Error) => ({ installed: false, loggedIn: false, detail: e.message }))
    return d.installed && d.loggedIn ? null : `${tool} cannot start a session here: ${d.detail}`
  }
}
