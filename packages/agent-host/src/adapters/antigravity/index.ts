import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import { dataRoot } from '../../data-dir.js'
import type { Platform } from '../../os.js'
import { rpcError } from '../../rpc-error.js'
import type { AgentProcess, AgentSpawnSpec, DetectResult } from '../contract.js'
import { AcpAdapter } from '../acp/adapter.js'
import type { AcpProfile } from '../acp/profile.js'
import { agyHome, agyPlatformKey, browserFolder, reachesAgentFolder, type AgyHome } from './agent-files.js'
import { agyLaunch } from './launch.js'
import { AGY_RELEASE, type AgyArchive } from './release.js'
import { AgySetup, type AgySetupDeps } from './setup.js'
import { agyCentraluTool, agySessionMeta, agyStderrLine, isAgyQuestion, isAgySubagentCall, readAgyCall } from './shape.js'
import { signInUrl } from './sign-in.js'
import { AGY_SURFACE } from './surface.js'

/**
 * What Google's Antigravity agent through ACP can keep (docs/plans/antigravity-adapter.md §6), measured on 1.4.3:
 * - **Presets: all four.** The agent stays in its `default` mode, where it asks for every command, edit, web fetch and MCP
 *   call (reads and searches do not ask, as under Claude's Safe); Centralu's preset answers each request. Its own
 *   `auto_edit` and `yolo` would skip Centralu, so they are never set, and `allow_always` is never sent (spike §5)
 * - **Context: exact** (`usage_update {used, size: 1048576}`), no cost
 * - Resume: `session/load` (replays, dropped) under the one `GEMINI_HOME` Centralu keeps
 * - Not offered yet: role text (`_meta.antigravity.systemPrompt.append` exists, unmeasured), untrusted projects (it reads
 *   the project's own instruction files, as the other ACP tools), images in the prompt, the model and effort menus
 */
const CAPABILITIES: AdapterCapabilities = {
  approvals: true,
  contextUsage: 'exact',
  resume: true,
  autoTitle: false,
  attachments: [],
  verbosities: [],
  exclusiveWriter: false,
  backgroundTasks: false,
  midTurnInput: false,
  gatesSteps: false,
  toolDeferral: false,
  instructionChannel: 'server',
  processModel: 'per-session',
  builtInSubagents: false,
  peerMessaging: false,
  sleep: false,
  keepsRepoFilesOut: false,
  roleText: false,
}

/** The label and mark carried over from the earlier `agy` design; install and sign-in are Centralu's own (`ToolSetup`) */
const DESCRIPTOR: ToolDescriptor = {
  name: 'antigravity',
  label: 'Antigravity',
  mark: 'A',
  install: "Install it from Antigravity's line in Centralu.",
  login: "Sign in with Google from Antigravity's line in Centralu.",
}

export type AgyProfileDeps = Partial<Pick<AgySetupDeps, 'installIo' | 'signIn' | 'runSignIn' | 'runInstall'>> & {
  dataDir?: string
  platform?: Platform
  arch?: string
}

export type AgyProfile = AcpProfile & { readonly agySetup: AgySetup; readonly home: AgyHome; readonly archive: AgyArchive | null }

export function antigravityProfile(deps: AgyProfileDeps = {}): AgyProfile {
  const key = agyPlatformKey(deps.platform, deps.arch)
  const archive = key ? AGY_RELEASE.archives[key] : null
  const home = agyHome(deps.dataDir ?? dataRoot(), AGY_RELEASE.version)
  const setup = new AgySetup({ home, archive, version: AGY_RELEASE.version, ...deps })
  return {
    descriptor: DESCRIPTOR,
    capabilities: CAPABILITIES,
    surface: AGY_SURFACE,
    agySetup: setup,
    home,
    archive,
    async launch() {
      if (!archive || !setup.installed()) return null
      // Its own BROWSER helper (`browserFolder`): the agent never opens a browser itself, and the helper handed a Google
      // sign-in address in a session's process is how a stored sign-in that stopped working is told (`SignInWanted`). No
      // address is opened from a session: the person asked for a conversation, and the line offers Sign in. Another
      // address (none is known: its browser subagent drives its own Chrome) is dropped, never taken for a sign-in
      const folder = await browserFolder(home, deps.platform)
      return {
        ...agyLaunch(home, archive, folder.browser),
        signInWanted: {
          watch: (wanted: () => void) => folder.watch((text) => (signInUrl(text) ? wanted() : undefined)),
          remove: () => folder.remove(),
        },
      }
    },
    async installedVersion() {
      return setup.installed() ? AGY_RELEASE.version : null
    },
    async detect(): Promise<DetectResult> {
      const now = setup.current()
      const installed = setup.installed()
      const loggedIn = now.state === 'ready'
      const detail = !archive ? 'Not available on this system' : !installed ? 'Not installed' : loggedIn ? `antigravity-acp ${AGY_RELEASE.version}` : `antigravity-acp ${AGY_RELEASE.version} · sign-in required`
      return { tool: DESCRIPTOR.name, installed, loggedIn, detail, setup: now }
    },
    centraluToolOf: agyCentraluTool,
    shape: {
      readCall: readAgyCall,
      isQuestion: isAgyQuestion,
      // A subagent (it reads the agent's home with no card), or a file in the agent's own folder but its plan (§4.2)
      neverAllowed: async (req, cwd) => isAgySubagentCall(req) || (await reachesAgentFolder(home, req.toolCall, req.sessionId, cwd)),
      editRunsAsNewCall: true,
      // The agent's own folder: its token, its settings, its binaries
      clientReads: { refused: () => [home.root] },
      sessionMeta: agySessionMeta,
      stderrLine: agyStderrLine,
      signedOut(label) {
        setup.noteSignedOut()
        return rpcError(`${label} is not signed in. Sign in with Google from its line in Centralu, then try again.`, 'not_logged_in')
      },
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
