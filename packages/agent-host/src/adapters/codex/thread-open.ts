import { CLIENT_INFO, parseCliVersion } from '@cc/protocol'
import { codexToolInstructionsFor } from '../../sessions/orchestrator-tools.js'
import { rpcError } from '../../rpc-error.js'
import type { CreateSessionOpts, EventSink } from '../contract.js'
import type { CodexClient } from './client.js'
import { permissionOptionsFor, repoFilesConfig } from './launch-config.js'
import { runningTurnOf } from './turn-reads.js'

/**
 * How a session's thread is opened (`CodexSession.start`): the app-server's handshake, what `thread/resume` and
 * `thread/start` are sent, and what their answers say.
 */

/** The `initialize` handshake; an adopted app-server that is already initialized is let through */
export async function initializeAppServer(client: CodexClient, sessionId: string, adopted: boolean, emit: EventSink): Promise<void> {
  try {
    const init = await client.request<{ userAgent?: unknown }>('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    client.notify('initialized')
    /*
     * The app-server's version, for moving the session to a newer install (#297). Codex reports it only here, in
     * `userAgent`: `<our client name>/<server version> (<os>) …` (measured, codex-cli 0.160.0, 2026-10-05:
     * "centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)"). An adopted app-server is not
     * initialized again; its version comes from the keeper's tag instead (manager.adoptKept).
     */
    const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
    const version = parseCliVersion(ua.slice(ua.indexOf('/') + 1))
    if (version) emit({ type: 'agent_version', sessionId, version })
  } catch (err) {
    /*
     * An app-server adopted from a previous host (#280 step 2) is the same stdio connection, already
     * initialized. Measured (codex-cli 0.160.0, gpt-5.6-luna, 2026-10-04): the second `initialize`
     * is rejected with -32600 "Already initialized" and nothing else changes; `thread/resume` then
     * answers with the running turn and re-sends a pending approval under the same request id.
     */
    if (!adopted || !/already initialized/i.test((err as Error).message)) throw err
  }
}

/** What `thread/resume` is sent: `servers` are the MCP servers (`CodexServers.mcpConfig`), `workspaceConfig` the sandbox's (`sandboxConfig`) */
export function resumeThreadParams(opts: CreateSessionOpts, servers: Record<string, unknown>, workspaceConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: opts.resumeExternalId,
    ...permissionOptionsFor(opts.permissionPreset),
    /*
     * Metadata only, not the whole history (#342). Nothing here reads the history the resume used to return
     * except the running turn's id, and that has its own one-turn query below. Measured (codex-cli 0.160.0,
     * gpt-5.6-luna, a five-turn scratch thread, 2026-10-05): 1,206 KB / 761 ms and a `deprecationNotice`
     * ("Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…") that #304 put
     * in the conversation, against 1.9 KB / 351 ms and no notice. One long thread's answer was 23 MB
     * (client.ts). A Codex that predates the flag ignores it and answers with the turns, as before.
     */
    excludeTurns: true,
    /*
     * Verbosity has to be carried through on resume too (#54). turn/start has no place for
     * it (unlike effort), so these two spots where the thread is started are the only
     * place — leaving it out here becomes the quiet kind of loss where settings reset every
     * time the session wakes back up.
     *
     * Reasoning summary is the same case (measured for #58): unless this switch is turned
     * on, the item/reasoning/* stream **never arrives, not once** — the kind of feature
     * where wiring it up without flipping the switch does nothing at all.
     */
    config: {
      model_reasoning_summary: 'auto',
      ...(opts.verbosity ? { model_verbosity: opts.verbosity } : {}),
      ...(opts.serviceTier ? { service_tier: opts.serviceTier } : {}),
      /*
       * MCP servers are loaded **on resume too** (M4 A-5, plan "to confirm separately" 1).
       *
       * The old resume sent no servers at all — if the initial settings do not survive on
       * the thread, a Codex orchestrator that wakes back up loses the centralu tools.
       * Whether they actually survive can only be known by running it (S-7), and we could
       * not re-check because Codex was logged out. So we load them again without waiting
       * for that confirmation: resume's `config` is a settings override (generated type
       * ThreadResumeParams — "Configuration overrides for the resumed thread"), so the same
       * name lands in the same slot, and overwriting it loses nothing if it had survived.
       * For apps, resume is effectively "starting the next thread" — an app attached while
       * the thread was running gets attached here.
       */
      ...servers,
      // Files in the repository only reach this thread in a trusted project — resume follows the same rule (#92)
      ...repoFilesConfig(opts),
      ...workspaceConfig,
    },
  }
}

/**
 * A resume's failure as it is thrown on.
 *
 * The raw message ("already has an active writer") explains nothing to the user.
 *
 * And **a sentence meant for a human is not enough on its own** — if the layer above has
 * to re-parse that sentence with a regular expression, that is not a contract. We surface
 * a machine-readable code alongside it: the UI needs this code to be able to offer
 * "split off and continue" (codex's thread/fork works fine even on a locked thread —
 * confirmed by measurement).
 */
export function resumeFailure(err: unknown): unknown {
  const msg = (err as Error).message
  if (/active writer/i.test(msg)) {
    /*
     * Measurement (#57) narrowed down what this error actually means: the lock is a flock,
     * not a file's mere existence, so a file left behind by a dead process **cannot**
     * produce this error. Landing here means a live process is holding the flock at this
     * exact moment — codex running in a terminal, another app, or an orphan that survived
     * without being cleaned up, having inherited only the fd.
     */
    return rpcError('This conversation is already open elsewhere (codex in a terminal, another app, or a process left behind by an unclean shutdown)', 'conversation_locked')
  }
  return err
}

/** What `thread/start` is sent (see `resumeThreadParams` for `servers` and `workspaceConfig`) */
export function startThreadParams(opts: CreateSessionOpts, servers: Record<string, unknown>, workspaceConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    cwd: opts.cwd,
    ...permissionOptionsFor(opts.permissionPreset),
    model: opts.model,
    /*
     * The following two are attached only for the orchestrator.
     *
     * The role is given directly through developerInstructions — the same slot as Claude's
     * systemPrompt append. The reason we avoid a file (AGENTS.md) is the same: if a
     * lower-privilege session could edit that file, it would become able to instruct every
     * session. The instructions of the Centralu tools ride there too (#525, developerInstructions()).
     *
     * Tools are attached through the stdio bridge. What we confirmed by measurement:
     *   per-thread config.mcp_servers  works (our command actually runs)
     *   the url (HTTP) approach        does not — not a single request ever arrives
     * So one extra process ends up running — a cost that does not exist on the Claude path.
     */
    ...developerInstructions(opts),
    /*
     * config is **assembled in this one place only.** There used to be a trap where the
     * verbosity spread and the orchestrator spread each built their own config keys, and one
     * would silently overwrite the other entirely — once there were three contributors
     * (summary, verbosity, orchestrator), it became cheaper to remove the trap than to keep
     * remembering it.
     */
    config: {
      // The reasoning-summary switch (measured for #58): without it, the item/reasoning/* stream never arrives
      model_reasoning_summary: 'auto',
      ...(opts.verbosity ? { model_verbosity: opts.verbosity } : {}),
      // Response speed (measured: priority = "Fast, 1.5x speed, increased usage")
      ...(opts.serviceTier ? { service_tier: opts.serviceTier } : {}),
      // MCP servers — the orchestrator's bridge and any attached external app's bridge (including approved MCP servers) (see mcpConfig)
      ...servers,
      // Files in the repository (.codex/ settings, hooks, rules, AGENTS.md) only in a trusted project (#92, repoFilesConfig)
      ...repoFilesConfig(opts),
      ...workspaceConfig,
    },
  }
}

/** Whether the thread's sandbox reaches the network, from a start or resume answer; undefined when it does not say */
export function networkAccessOf(res: Record<string, unknown>): boolean | undefined {
  const sandbox = res.sandbox as { type?: string; networkAccess?: boolean | string } | undefined
  return sandbox?.type === 'dangerFullAccess' || sandbox?.networkAccess === 'enabled'
    ? true
    : typeof sandbox?.networkAccess === 'boolean' ? sandbox.networkAccess : undefined
}

/**
 * The thread's developer instructions: the session's role, then the instructions of the Centralu tools it gets
 * (#525), which Claude receives from the in-process server and Codex would never show from the bridge's
 * `initialize` (measured: sessions/orchestrator-tools.ts, codexToolInstructionsFor). Sent at thread/start only.
 * `thread/resume` takes the same field and ignores it: resumed with other developer instructions, the model still
 * named the phrase from the first ones and the rollout gained no developer message (codex-cli 0.160.0,
 * `scripts/probe-codex-mcp-instructions.mts`, 2026-10-12). So a thread keeps what it was started with; a session
 * that changes profile while its thread lives on (a session the person turns the reader set off for, or back on)
 * keeps its tools' new rules from the tool descriptions alone until it starts a new thread.
 */
export function developerInstructions(opts: CreateSessionOpts): { developerInstructions?: string } {
  const tools = opts.orchestratorTools && opts.orchestratorBridge ? codexToolInstructionsFor(opts.toolProfile ?? 'orchestrator') : undefined
  const text = [opts.systemPromptAppend, tools].filter(Boolean).join('\n\n')
  return text ? { developerInstructions: text } : {}
}

/**
 * The turn an adopted thread is still running, asked for on its own (#342): a resume with `excludeTurns` answers
 * with no turns. Measured (codex-cli 0.160.0, 2026-10-05), a second `thread/resume` on the same connection while a
 * turn ran said `status: {type: 'active'}` and `turns: []`; `thread/turns/list` with `limit: 1`, newest first and
 * `itemsView: 'notLoaded'` named that turn as `inProgress` in 0.5 KB. Asked only for an active thread. A Codex
 * without the method answers with the turns in the resume itself, which `runningTurnOf` read first.
 */
export async function latestRunningTurn(client: CodexClient, sessionId: string, threadId: string | null, res: Record<string, unknown>): Promise<string | null> {
  const status = (res.thread as { status?: { type?: unknown } } | undefined)?.status
  if (status?.type !== 'active' || !threadId) return null
  try {
    const page = await client.request<{ data?: unknown }>('thread/turns/list', {
      threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    })
    return runningTurnOf({ thread: { turns: page?.data } })
  } catch (err) {
    console.error(`[codex] ${sessionId.slice(0, 8)} could not ask for the running turn: ${(err as Error).message}`)
    return null
  }
}
