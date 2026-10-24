import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { launchFor, toolCommand } from '../../tool-launch.js'
import { installedCliVersion } from '../../cli-version.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { withCodexClient } from './short-lived.js'
import { codexHome } from './home.js'
import { lastCompactSummary as rolloutLastCompactSummary } from './rollout.js'
import type { Verbosity } from './generated/Verbosity.js'
import { listCodexThreads, readCodexHistory } from './history.js'
import { readCodexUsage } from './usage-client.js'
import { listCodexModels } from './models.js'
import { raceTimeout } from '../../timing.js'
import { threadIdOf } from './turn-reads.js'
import { CodexSession, LAZY_RESUME_WAIT_MS } from './session.js'
import { CODEX_SURFACE } from './surface.js'
import { APP_CALL_WAIT_MS, appApprovalModeFor, CODEX_TOOL_TIMEOUT_SEC, permissionOptionsFor, repoFilesConfig } from './launch-config.js'

export { APP_CALL_WAIT_MS, appApprovalModeFor, CODEX_TOOL_TIMEOUT_SEC, LAZY_RESUME_WAIT_MS, repoFilesConfig }

const exec = promisify(execFile)

/**
 * Codex adapter (protocol and approval-override verification completed in M0).
 *
 * Design verification target (A-4): does adding only this directory leave the UI and core
 * unchanged? Rule: Codex types end here — the only thing that leaves is NormalizedEvent.
 */

/**
 * The verbosity levels (#54). `model/list` does not report them per model, so we write them here
 * instead — but tied to the generated type (generated/Verbosity.ts, extracted by ts-rs from codex
 * source): if codex adds or removes a level, one of the two checks below **fails at compile time**.
 * Measured (codex exec, same question): low 82 words, high 269 words — the names earn their keep.
 */
const CODEX_VERBOSITIES = ['low', 'medium', 'high'] as const satisfies readonly Verbosity[]
// Checks that no level is missing — satisfies only catches a "wrong value", not a "missing value"
type MissingVerbosity = Exclude<Verbosity, (typeof CODEX_VERBOSITIES)[number]>
const _allVerbositiesListed: MissingVerbosity extends never ? true : never = true
void _allVerbositiesListed

export class CodexAdapter implements AgentAdapter {
  readonly tool = 'codex' as const
  readonly cacheBilling = 'openai' as const
  /** What Codex offers against what this adapter limits (#270) */
  readonly surface = CODEX_SURFACE

  readonly descriptor: ToolDescriptor = {
    name: 'codex',
    label: 'Codex',
    mark: 'X',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
  }

  readonly capabilities: AdapterCapabilities = {
    approvals: true, // Measured in M0: thread/start's approvalPolicy overrides the global setting
    contextUsage: 'exact', // thread/tokenUsage/updated
    resume: true, // thread/resume
    autoTitle: true, // thread/name/updated
    attachments: ['image', 'file'],
    verbosities: [...CODEX_VERBOSITIES],
    // The app-server's writer lock ("already has an active writer" — the error client.ts
    // translates). This is a guarantee that every record change while we hold the handle is ours,
    // and the manager marks a catch-up skip on top of it (the basis for skipping a 48.6MB/8-second thread/read).
    exclusiveWriter: true,
    // Child agents, from their threads' status and turns (#290, CodexChildTracker)
    backgroundTasks: true,
    toolDeferral: false,
    instructionChannel: 'developer',
    processModel: 'per-session',
    builtInSubagents: true,
    peerMessaging: false,
    // 0.160 TurnStartParams: turn/start steers an already-active regular turn; compact/review input is queued.
    midTurnInput: true,
    /*
     * Not put to sleep (#568). Waking a large thread measured 7-13 s (`thread/resume` scales with the rollout, ~13.5 s for
     * 550 MB), and its cache on resume is unmeasured. The memory is better won by one shared app-server per account
     * (#561 E3: 379 MB vs 2,584 MB for ten threads), decided separately.
     */
    sleep: false,
  }

  launchSettingsFingerprint(settings: import('../contract.js').LaunchSettings): string {
    // The working directory participates in the sandbox roots. Bump the version when the
    // adapter derives a different sandbox, network or bridge launch policy from these settings.
    // v2: #597 changes auto's sandbox to full access. Kept sessions must restart to pick it up.
    return JSON.stringify({ v: 2, cwd: settings.cwd, permission: settings.permissionPreset, sandbox: permissionOptionsFor(settings.permissionPreset).sandbox, trusted: !!settings.projectTrusted, noSettings: !!settings.noSettingFiles })
  }

  /** The installed Codex CLI (#297), from npm's `package.json` where it came from npm, else `codex --version` */
  installedVersion(): Promise<string | null> {
    return installedCliVersion('codex', '@openai/codex')
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('codex')
    try {
      const launch = launchFor(path ?? toolCommand('codex'))
      const { stdout } = await exec(launch.command, [...launch.args, '--version'], { timeout: 5000, windowsHide: true })
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      // Login status is judged by whether the auth file exists (cheap — no need to start the CLI)
      const loggedIn = existsSync(join(codexHome(), 'auth.json'))
      return {
        tool: 'codex',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'codex',
        installed: false,
        loggedIn: false,
        detail: 'codex CLI not found (check with `which codex` in a terminal)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listCodexThreads(cwd, limit, toolCommand('codex'))
  }

  /**
   * Splits off a new thread from a locked conversation (`thread/fork`).
   *
   * Uses a **short-lived client**, for the same reason as the usage lookup — this happens
   * **before** a session is created, not as part of one, so there is no thread yet to hold onto.
   *
   * The original is left untouched. Codex leaves the provenance on the new thread as `forkedFromId`.
   */
  async forkConversation(externalId: string, cwd: string): Promise<string> {
    return withCodexClient({ cwd, command: toolCommand('codex') }, async (client) => {
      // Only the new id is read: the forked history stays with Codex (#342, the same deprecation as resume's)
      const res = await client.request<Record<string, unknown>>('thread/fork', { threadId: externalId, excludeTurns: true })
      const forked = threadIdOf(res)
      // Claiming a fork happened without giving a new id leaves nothing to continue from — falling back to the original silently would just be locked again
      if (!forked) throw new Error('codex forked the conversation but returned no thread id')
      return forked
    })
  }

  /**
   * Deletes the original thread (the thread/delete RPC). A short-lived client, for the same reason
   * as fork — the session has already been disposed of, so there is no process left to hold onto.
   * This call is what makes the tool itself reclaim the rollout file (measured: a 550MB one
   * disappears here).
   */
  async deleteExternalConversation(externalId: string, cwd: string): Promise<void> {
    await withCodexClient({ cwd, command: toolCommand('codex') }, async (client) => {
      try {
        await client.request('thread/delete', { threadId: externalId })
      } catch (e) {
        /*
         * **Asking to delete something that does not exist is not a failure** (dogfooding
         * 2026-09-07: trying to delete a worktree session that had been created by mistake gave
         * "Could not delete: no rollout found for thread id …").
         *
         * Measured: codex only issues the thread id at thread/start and writes the rollout file on
         * **the first turn**. So a session that never had a single message exchanged has no file to
         * delete, and thread/delete rejects it with -32600. Throwing that rejection as-is would stop
         * the manager here and leave neither the session row nor the worktree deleted — the more
         * mistaken the session, the less deletable it would become.
         *
         * The goal ("make sure nothing is left on the tool side") is already achieved, so we treat
         * this as success. Any other failure is still thrown — the rule that answering "deleted"
         * while the original still exists is the worst outcome (per the manager's own comment) still
         * holds.
         */
        if (!/no rollout found/i.test((e as Error).message)) throw e
      }
    })
  }

  /** The last compact summary of a dead codex process (#78) — read from the rollout file, with no binary involved (rollout.ts) */
  async lastCompactSummary(externalId: string): Promise<string | null> {
    return rolloutLastCompactSummary(externalId)
  }

  /**
   * Account usage (FR-9).
   * Asked with a short-lived client, since it has nothing to do with any session — we do not
   * pile the lookup onto a thread that is mid-conversation.
   */
  async listUsage() {
    return readCodexUsage(toolCommand('codex'))
  }

  async listModels() {
    return listCodexModels(toolCommand('codex'))
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readCodexHistory(externalId, cwd, limit, toolCommand('codex'))
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const session = new CodexSession(opts, emit)
    /*
     * **Resume works like Claude's — we do not make the person wait for it** (dogfooding: the same
     * thread took 3 seconds in the CLI, 13+ seconds on our path. We cannot remove the cost of
     * thread/resume re-reading the whole file, but there is no reason to make the person pay that
     * cost in front of a "Waking…" screen — resume already knows the thread id, so handing out the
     * handle early loses nothing. send gets queued on ready). Since #342 the answer no longer carries
     * the history (`excludeTurns`); what Codex itself spends loading a long rollout was not measured
     * again, so the early handle stays.
     *
     * We do wait synchronously for 3 seconds, though: a lock error ("already has an active writer")
     * arrives immediately (measured ~0.3s), so it has to be thrown within this window for the
     * "open elsewhere -> split off and continue" fork-in-the-road UI to keep working as it does now.
     * A brand-new thread (thread/start) still waits all the way to completion as before — resume is
     * only possible once an id exists (a lesson from M1.5 defect 5).
     */
    if (opts.resumeExternalId) {
      session.externalId = opts.resumeExternalId
      const outcome = await raceTimeout(
        session.ready.then(
          () => 'ready' as const,
          (err: unknown) => ({ err }),
        ),
        LAZY_RESUME_WAIT_MS,
        'pending' as const,
      )
      if (outcome === 'pending') {
        session.watchBackgroundStart()
        return session
      }
      if (outcome !== 'ready') {
        await session.dispose().catch(() => {})
        throw outcome.err
      }
      return session
    }
    try {
      await session.ready
    } catch (err) {
      /*
       * A session that failed to become ready never has its handle handed out — there is nobody
       * left to call dispose on it. If we did not reclaim the app-server the constructor already
       * started here, a child process would leak silently, one at a time, every time resuming a
       * locked thread failed.
       */
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}
