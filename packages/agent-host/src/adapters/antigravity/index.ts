import { notSignedIn, type AdapterCapabilities, type ToolDescriptor, type UsageSnapshot } from '@cc/protocol'
import { CENTRALU_MCP_NAME } from '../../apps/contract.js'
import { dataRoot } from '../../data-dir.js'
import type { Platform } from '../../os.js'
import { rpcError } from '../../rpc-error.js'
import { instructionsFor } from '../../sessions/centralu-tools.js'
import { toolProfileOf, type AgentProcess, type AgentSpawnSpec, type CreateSessionOpts, type DetectResult } from '../contract.js'
import { AcpAdapter } from '../acp/adapter.js'
import { ACP_CAPABILITIES, type AcpProfile } from '../acp/profile.js'
import { toolNotInstalled } from '../core/tool-process.js'
import { agyAppFinder, agyHome, agyPlatformKey, browserFolder, findInstalledAgy, sweepSessionTemps, type AgyHome, type HelperPlaces } from './agent-files.js'
import { agyLaunch } from './launch.js'
import { AGY_RELEASE, KNOWN_AGY_RELEASES, type AgyArchive } from './release.js'
import { AgySetup, type AgySetupDeps } from './setup.js'
import { agyCentraluTool, agyStderrLine, isAgyQuestion, readAgyCall } from './shape.js'
import { agentSignInUrl, googleAuthorizeUrl } from './sign-in.js'
import { AGY_SURFACE } from './surface.js'
import { agyUsageSnapshot, readAgyUsage, type UsageReadDeps } from './usage.js'
import { listAgyModels, saveAgyModels, toModelOptions } from './models.js'

/** What Antigravity calls its own subagent tool: named in Centralu's tool instructions before `start_agent` */
const AGY_SUBAGENT_TOOL = 'invoke_subagent'

/**
 * System prompt appended via `_meta.antigravity.systemPrompt.append` on `session/new`, `session/load`, and
 * `session/resume`: the session's role text (`opts.systemPromptAppend`), followed by Centralu's MCP tool instructions
 * when the Centralu bridge is attached (since `centralu-bridge.mjs` omits MCP `initialize.instructions`).
 * Heading names the MCP server rather than `mcp__centralu__*` because Antigravity calls tools via `call_mcp_tool`.
 */
export function agySystemPrompt(opts: CreateSessionOpts): string | undefined {
  const apps = (opts.apps?.current().length ?? 0) > 0
  const rawTools =
    opts.centraluTools && opts.centraluBridge
      ? instructionsFor(toolProfileOf(opts), undefined, apps, AGY_SUBAGENT_TOOL)
      : undefined
  const tools = rawTools ? `# How to use the ${CENTRALU_MCP_NAME} MCP server tools\n\n${rawTools}` : undefined
  const text = [opts.systemPromptAppend, tools].filter(Boolean).join('\n\n')
  return text || undefined
}

/**
 * What Google's Antigravity agent through ACP can keep (docs/plans/antigravity-adapter.md §6), measured on 1.4.3:
 * - **Presets: all four.** The agent stays in its `default` mode, where it asks for every command, edit, web fetch, MCP
 *   call and subagent; Centralu's preset answers each request as it answers any tool's, with no request refused for what
 *   it names (owner decision on #59, 2026-10-28: the agent runs as shipped). Its own viewer and search read files without
 *   asking, as under Claude's Safe, its own folder too (plan §4.2); a subagent runs once its card is allowed (or at once
 *   under Auto), and its events are not read as a child's (`builtInSubagents: false`). Its own `auto_edit` and `yolo`
 *   would skip Centralu, so they are never set, and `allow_always` is never sent (spike §5)
 * - **Context: exact** (`usage_update {used, size: 1048576}`), no cost
 * - Resume: `session/load` (replays, dropped) under the one `GEMINI_HOME` Centralu keeps
 */
const CAPABILITIES: AdapterCapabilities = {
  // What the agent does or lacks beyond these fields (`attachments` and `keepsRepoFilesOut` stay at the ACP defaults):
  // - Files of its own in the project: on Linux (measured, 1.4.3 and 1.5.0) and macOS (seen), it writes its `run_workflow`
  //   skill as `skills/system/run-workflow/SKILL.md` into the session's project at `session/new`; Windows 1.4.3 writes none
  //   (#2320, docs/plans/antigravity-acp.md §1 has the cause)
  // - System prompt & role text: passed through `_meta.antigravity.systemPrompt.append` on session/new, session/load, and session/resume
  // - Not offered: untrusted projects (it reads the project's own instruction files, and `agy` 1.5.2 has no flag or variable to stop it)
  ...ACP_CAPABILITIES,
  autoTitle: false,
  instructionChannel: 'developer',
  subagentTool: AGY_SUBAGENT_TOOL,
  roleText: true,
}

/** Install and sign-in are Centralu's own (`ToolSetup`) */
const DESCRIPTOR: ToolDescriptor = {
  name: 'antigravity',
  label: 'Antigravity',
  mark: 'A',
  install: "Install it from Antigravity's line in Centralu.",
  login: "Sign in with Google from Antigravity's line in Centralu.",
}

export type AgyProfileDeps = Partial<Pick<AgySetupDeps, 'appFound' | 'autoUpdate' | 'fetchRelease' | 'installIo' | 'signIn' | 'runSignIn' | 'runInstall'>> & {
  dataDir?: string
  platform?: Platform
  arch?: string
  /** Where a session's `BROWSER` helper may go (`browserFolder`): its real places when not given */
  helperPlaces?: HelperPlaces
  /** How the usage read starts its process and how long it waits (`readAgyUsage`) */
  usage?: Pick<UsageReadDeps, 'spawn' | 'timeoutMs'>
}

export type AgyProfile = AcpProfile & { readonly agySetup: AgySetup; readonly home: AgyHome; readonly archive: AgyArchive | null }

export function antigravityProfile(deps: AgyProfileDeps = {}): AgyProfile {
  const root = deps.dataDir ?? dataRoot()
  const baseHome = agyHome(root, AGY_RELEASE.version)
  const key = agyPlatformKey(deps.platform, deps.arch)
  // Restore the newest valid install on disk (pinned or auto-updated); otherwise target the pinned default release
  const existing = key ? findInstalledAgy(baseHome, KNOWN_AGY_RELEASES, key) : null
  const initialVersion = existing?.version ?? AGY_RELEASE.version
  const initialArchive = existing?.archive ?? (key ? AGY_RELEASE.archives[key] : null)
  const initialHome = existing?.home ?? baseHome
  const setup = new AgySetup({
    home: initialHome,
    archive: initialArchive,
    version: initialVersion,
    platformKey: key,
    autoUpdate: true,
    appFound: agyAppFinder(deps.platform),
    ...deps,
  })
  /** A process found the sign-in gone: the line turns signed out */
  const signedOut = () => {
    setup.noteSignedOut()
    return rpcError(notSignedIn(DESCRIPTOR, 'centralu'), 'not_logged_in')
  }
  let reading: Promise<UsageSnapshot> | null = null
  return {
    descriptor: DESCRIPTOR,
    capabilities: CAPABILITIES,
    surface: AGY_SURFACE,
    agySetup: setup,
    get home() { return setup.home },
    get archive() { return setup.archive },
    async launch(opts) {
      const archive = setup.archive
      const home = setup.home
      if (!archive || !setup.installed()) return null
      // Its own BROWSER helper (`browserFolder`): the agent never opens a browser itself, and the helper handed the agent's
      // own login request in a session's process is how a stored sign-in that stopped working is told (`SignInWanted`).
      // No address is opened from a session: the person asked for a conversation, and the line offers Sign in. Every
      // command the agent runs inherits `BROWSER`, so any other address (`gcloud auth login`, a script opening a page) is
      // only logged, never opened and never taken for a sign-in (plan §4.4)
      const folder = await browserFolder(home, deps.platform, deps.helperPlaces, opts.sessionId)
      if (folder.browser === '') {
        // Without a helper the agent's launcher would start the browser itself, on Windows inside the host's job, and a
        // stored sign-in that stopped working would hang the start again (#1685); without its TEMP it cannot unpack itself.
        // Refused rather than started. A path does not change between tries, so the refusal is not worth retrying (#1688)
        console.error(`[Antigravity] session refused: ${folder.why}`)
        throw rpcError(`Antigravity cannot start: ${folder.why}`, 'refused', { retryable: false, data: { reason: folder.refusal } })
      }
      return {
        ...agyLaunch(home, archive, folder),
        signInWanted: {
          watch: (wanted: () => void) =>
            folder.watch((text) => {
              if (agentSignInUrl(text)) return wanted()
              // Google's v2 authorize page with another client may be a new agent release whose client was not measured
              // (`AGY_RELEASE.oauthClient`): said apart, so a sign-in that stopped working there is not lost in the log
              const other = googleAuthorizeUrl(text)
              console.error(
                other
                  ? "[Antigravity] a session's process asked for a Google sign-in with an OAuth client that is not the agent's; not opened, not taken for its sign-in"
                  : "[Antigravity] a command in a session asked for a browser; not opened (it is not the agent's sign-in)",
              )
            }),
          remove: () => folder.remove(),
        },
      }
    },
    sweepSessionFiles: (kept) => sweepSessionTemps(setup.home, kept),
    async installedVersion() {
      return setup.installed() ? setup.version : null
    },
    async detect(): Promise<DetectResult> {
      const now = setup.current()
      const installed = setup.installed()
      const loggedIn = now.state === 'ready'
      const detail = !setup.archive ? 'Not available on this system' : !installed ? 'Not installed' : loggedIn ? `antigravity-acp ${setup.version}` : `antigravity-acp ${setup.version} · sign-in required`
      return { tool: DESCRIPTOR.name, installed, loggedIn, detail, setup: now }
    },
    centraluToolOf: agyCentraluTool,
    shape: {
      readCall: readAgyCall,
      isQuestion: isAgyQuestion,
      editRunsAsNewCall: true,
      stderrLine: agyStderrLine,
      signedOut,
      supportsModelOption: true,
      interruptForInput: true,
      onConfigOptions: (options) => {
        const models = toModelOptions(options)
        if (models.length > 0) void saveAgyModels(setup.home, models).catch(() => {})
      },
      sessionMeta: (opts) => {
        const append = agySystemPrompt(opts)
        return append ? { antigravity: { systemPrompt: { append } } } : undefined
      },
    },
    listModels() {
      return listAgyModels(setup.home, setup.archive, setup, signedOut, DESCRIPTOR.label, DESCRIPTOR.install)
    },
    /*
     * Its weekly and five-hour limits per model group, from the agent Centralu signed in (`readAgyUsage`), one read at a
     * time. No `account()`: the sign-in is this machine's Centralu's own (plan §0), so a linked machine's usage is read there
     */
    listUsage() {
      const archive = setup.archive
      const home = setup.home
      if (!archive || !setup.installed()) return Promise.reject(toolNotInstalled(DESCRIPTOR.label, DESCRIPTOR.install))
      if (setup.current().state !== 'ready') return Promise.reject(signedOut())
      reading ??= readAgyUsage(home, archive, signedOut, { platform: deps.platform, helperPlaces: deps.helperPlaces, ...deps.usage })
        .then((quota) => agyUsageSnapshot(quota, setup.current().plan?.name ?? null))
        .catch((err: unknown) => {
          console.error(`[usage] antigravity: ${err instanceof Error ? err.message : String(err)}`)
          throw err
        })
        .finally(() => {
          reading = null
        })
      return reading
    },
  }
}

/** Google's Antigravity agent through the generic ACP adapter (docs/plans/antigravity-adapter.md) */
export class AntigravityAdapter extends AcpAdapter {
  readonly tool = 'antigravity'
  readonly setup: AgySetup

  constructor(profile: AgyProfile = antigravityProfile(), spawn?: (spec: AgentSpawnSpec) => AgentProcess) {
    super(profile, spawn)
    this.setup = profile.agySetup
  }
}
