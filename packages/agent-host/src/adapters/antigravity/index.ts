import type { AdapterCapabilities, ToolDescriptor } from '@cc/protocol'
import { dataRoot } from '../../data-dir.js'
import type { Platform } from '../../os.js'
import { rpcError } from '../../rpc-error.js'
import type { AgentProcess, AgentSpawnSpec, DetectResult } from '../contract.js'
import { AcpAdapter } from '../acp/adapter.js'
import { ACP_CAPABILITIES, type AcpProfile } from '../acp/profile.js'
import { agyHome, agyPlatformKey, browserFolder, type AgyHome } from './agent-files.js'
import { agyLaunch } from './launch.js'
import { AGY_RELEASE, type AgyArchive } from './release.js'
import { AgySetup, type AgySetupDeps } from './setup.js'
import { agyCentraluTool, agyStderrLine, isAgyQuestion, readAgyCall } from './shape.js'
import { agentSignInUrl, googleAuthorizeUrl, NO_HELPER } from './sign-in.js'
import { AGY_SURFACE } from './surface.js'

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
 * - Not offered yet: role text (`_meta.antigravity.systemPrompt.append` exists, unmeasured), untrusted projects (it reads
 *   the project's own instruction files, as the other ACP tools), images in the prompt, the model and effort menus
 */
const CAPABILITIES: AdapterCapabilities = {
  ...ACP_CAPABILITIES,
  autoTitle: false,
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
      // Its own BROWSER helper (`browserFolder`): the agent never opens a browser itself, and the helper handed the agent's
      // own login request in a session's process is how a stored sign-in that stopped working is told (`SignInWanted`).
      // No address is opened from a session: the person asked for a conversation, and the line offers Sign in. Every
      // command the agent runs inherits `BROWSER`, so any other address (`gcloud auth login`, a script opening a page) is
      // only logged, never opened and never taken for a sign-in (plan §4.4)
      const folder = await browserFolder(home, deps.platform)
      if (folder.browser === '') {
        // Without a helper the agent's launcher would start the browser itself, on Windows inside the host's job, and a
        // stored sign-in that stopped working would hang the start again (review of #1685): refused rather than started
        await folder.remove()
        console.error(`[Antigravity] session refused: ${NO_HELPER}`)
        throw rpcError(`Antigravity cannot start here: ${NO_HELPER}.`)
      }
      return {
        ...agyLaunch(home, archive, folder.browser),
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
      editRunsAsNewCall: true,
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
