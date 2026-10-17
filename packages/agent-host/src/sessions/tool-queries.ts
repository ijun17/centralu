import type { CacheLedger } from './cache-ledger.js'
import { remember } from './folder-cache.js'
import type {
  CacheStats,
  ModelOption,
  CommandInfo,
  SessionInfo,
  UsageSnapshot,
  ToolName,
} from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { withTimeout } from './with-timeout.js'

/** How long one read of a tool's model list may run, whoever waits on it (#660) */
const MODEL_LIST_READ_MS = 60_000

/** After a failed read, how long a caller that cannot wait goes without a list before one is tried again (#660) */
const MODEL_LIST_RETRY_MS = 60_000

/**
 * What the tool queries reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields, so each is read when used, never kept.
 */
export type ToolQueriesHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly cacheLedger: CacheLedger
  cwdFor: (m: SessionInfo) => string
  readonly handles: Map<string, SessionHandle>
  readonly meta: Map<string, SessionInfo>
  readonly store: Store
}

/**
 * What the host asks an agent tool outside a turn, and keeps for a while (#428): a session's slash commands (also when
 * it has no process), the tool's usage and cache figures, and its models, with the bounds that keep a slow or failing
 * tool from holding a call. Moved out of the session manager as it was; what it reaches is `ToolQueriesHost`.
 */
export class ToolQueries {
  constructor(private readonly host: ToolQueriesHost) {}

  /**
   * Slash-command cache per tool and directory (so a list can be returned even before a session is ready). Written
   * only through `remember`, like `externalIndex`, so it keeps the most recently used keys (folder-cache.ts)
   */
  private readonly commandCache = new Map<string, CommandInfo[]>()

  /** Usage cache — do not spin up the tool every time the modal opens and closes */
  private readonly usageCache = new Map<ToolName, { snapshot: UsageSnapshot; at: number }>()

  /**
   * The list of slash commands.
   *
   * **Skills are a property of tool + directory, not of a session.** So this is cached by (tool, cwd)
   * — right after a session is created, the CLI is still coming up and cannot be asked at all (a
   * dogfooding finding), but if it has ever been fetched once in the same project, a brand-new session
   * has the list immediately.
   *
   * If the tool is not ready yet, this reports ready=false — 'there is none' and 'not yet' are different
   * things.
   */
  async listCommands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }> {
    const m = this.host.meta.get(sessionId)
    if (!m) return { ready: false, commands: [] }
    const cwd = this.host.cwdFor(m)
    const key = `${m.tool}:${cwd}`
    // Looked up in memory first, then on disk. The list has to survive the host being turned off and
    // back on, so slash commands still work for a sleeping session
    const cached = this.commandCache.get(key) ?? this.host.store.settings.loadCommands<CommandInfo[]>(m.tool, cwd) ?? undefined
    if (cached) remember(this.commandCache, key, cached)

    const handle = this.host.handles.get(sessionId)
    if (handle?.listCommands) {
      try {
        // Before it is ready, a response may never come at all — do not hold the composer hostage
        const rows = await withTimeout(handle.listCommands(), 4000)
        const commands = rows
          .filter((c) => typeof c.name === 'string' && c.name.length > 0)
          .map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' }))
        if (commands.length > 0) {
          remember(this.commandCache, key, commands)
          this.host.store.settings.saveCommands(m.tool, cwd, commands)
        }
        return { ready: true, commands }
      } catch {
        // Falls back to the cache below
      }
    }
    return cached ? { ready: true, commands: cached } : { ready: false, commands: [] }
  }

  /**
   * Account usage and limits (FR-9).
   *
   * Cached briefly — spinning up a codex app-server every time the modal opens and closes would be
   * slow. Never throws on failure: failing to see usage is no reason to block the conversation.
   */
  async usageFor(
    tool: ToolName,
    opts: { limits?: boolean } = {},
  ): Promise<{ supported: boolean; reason?: string; usage: UsageSnapshot | null; cache: CacheStats }> {
    /*
     * The cache figures are summed now, on the question, from what this host counted: a sum over a day's requests at
     * most, cheap next to the tool call below, and nothing is kept up to date while nobody asks.
     */
    const cache = this.host.cacheLedger.stats(tool, (id) => this.host.meta.get(id)?.name)
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listUsage) return { supported: false, reason: `${tool} does not support usage queries`, usage: null, cache }
    // The hub shows its own limits for this machine (same account, #726): only the figures counted here are wanted
    if (opts.limits === false) return { supported: true, usage: null, cache }

    const hit = this.usageCache.get(tool)
    if (hit && Date.now() - hit.at < 60_000) return { supported: true, usage: hit.snapshot, cache }

    try {
      const snapshot = await withTimeout(adapter.listUsage(), 15_000)
      this.usageCache.set(tool, { snapshot, at: Date.now() })
      return { supported: true, usage: snapshot, cache }
    } catch (err) {
      return { supported: false, reason: (err as Error).message, usage: hit?.snapshot ?? null, cache }
    }
  }

  /**
   * The models that can be picked, and each model's reasoning effort levels.
   *
   * The only argument is tool because this sits on the same account axis as usage. The list rarely
   * changes, so it is cached for 5 minutes — spinning up the tool process every time the selector
   * opens would make that click feel slow.
   */
  private readonly modelCache = new Map<ToolName, { models: ModelOption[]; at: number }>()

  /** One read of a tool's list at a time: a second asker waits on it instead of starting another tool process */
  private readonly modelFetches = new Map<ToolName, Promise<ModelOption[]>>()

  /** When a read last failed, so a caller that cannot wait does not start another one at once (#660) */
  private readonly modelFailures = new Map<ToolName, number>()

  /**
   * Reads the list once at a time and **keeps the result whenever it arrives**, also after the caller that asked has
   * stopped waiting: a Codex list that takes 20 seconds is cached for the next call instead of being thrown away at
   * the caller's bound and read again from scratch (#660). The read has its own ceiling, so it cannot stay pending
   * and block every later asker.
   */
  private fetchModels(tool: ToolName, adapter: AgentAdapter): Promise<ModelOption[]> {
    const running = this.modelFetches.get(tool)
    if (running) return running
    const p = withTimeout(adapter.listModels!(), MODEL_LIST_READ_MS, `${tool}'s model list`).then(
      (models) => {
        this.modelCache.set(tool, { models, at: Date.now() })
        this.modelFailures.delete(tool)
        return models
      },
      (err: unknown) => {
        this.modelFailures.set(tool, Date.now())
        throw err
      },
    )
    this.modelFetches.set(tool, p)
    const clear = () => {
      if (this.modelFetches.get(tool) === p) this.modelFetches.delete(tool)
    }
    p.then(clear, clear)
    return p
  }

  async listModels(tool: ToolName): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }> {
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listModels) {
      return { supported: false, reason: `${tool} does not support listing models`, models: [] }
    }

    const hit = this.modelCache.get(tool)
    if (hit && Date.now() - hit.at < 5 * 60_000) return { supported: true, models: hit.models }

    try {
      const models = await withTimeout(this.fetchModels(tool, adapter), 15_000)
      return { supported: true, models }
    } catch (err) {
      // Leaving the list empty just because it failed to read would erase even the model already chosen — the
      // last known list is kept instead
      return { supported: false, reason: (err as Error).message, models: hit?.models ?? [] }
    }
  }

  /**
   * The list for checking a choice, **never waiting longer than `ms`** (#660). A list we already have, however old,
   * answers at once (and an old one is refreshed in the background); otherwise one read is started or joined and
   * waited on for `ms`. Null when there is no list in time: the caller goes on without checking. A read that fails
   * is not started again for a minute, so a hung Codex does not get a new tool process on every call.
   *
   * `fresh` skips the cached list and reads again: the CLI may have been updated since, so a name the cached list
   * lacks is not refused on its word alone. `cached` says which kind of list came back.
   */
  async modelsWithin(tool: ToolName, ms: number, fresh = false): Promise<{ models: ModelOption[]; cached: boolean } | null> {
    const adapter = this.host.adapters.get(tool)
    if (!adapter?.listModels) return null
    const hit = this.modelCache.get(tool)
    const stale = !hit || Date.now() - hit.at >= 5 * 60_000
    if (hit && !stale && !fresh) return { models: hit.models, cached: true }
    const failedAt = this.modelFailures.get(tool)
    const failedRecently = failedAt !== undefined && Date.now() - failedAt < MODEL_LIST_RETRY_MS && !this.modelFetches.has(tool)
    if (failedRecently) return hit && !fresh ? { models: hit.models, cached: true } : null
    const read = this.fetchModels(tool, adapter)
    // Nobody may be left waiting on this when it fails after the bound
    read.catch(() => {})
    if (hit && !fresh) return { models: hit.models, cached: true }
    try {
      return { models: await withTimeout(read, ms), cached: false }
    } catch {
      return null
    }
  }
}
