import type { AgentPort } from './agents.js'
import type { AppsPort } from './apps.js'
import type { FsPort } from './fs.js'
import type { GitPort } from './git.js'
import type { ApprovalRulesPort, SearchPort, TrashPort } from './history.js'
import type { BackgroundPort, DiagnosticsPort, ProcessPort, RelaunchPort, UpdatePort } from './lifecycle.js'
import type { MachinesPort } from './machines.js'
import type { MailPort } from './mail.js'
import type { HostRequestsPort } from './host-requests.js'
import type { PreferencesPort, ThemesPort, WorkspacePort } from './preferences.js'
import type { ProjectConsentsPort, ProjectPort } from './projects.js'
import type { PlatformCapabilities, SystemPort } from './system.js'
import type { CommandRunPort, TerminalPort } from './terminal.js'

/**
 * The Platform port (docs/platform-abstraction.md §2).
 * The only outside world ui knows about. The implementations (web/tauri/mock) know only the
 * apps entry point.
 *
 * Rules:
 *  - Every method returns a Promise (even a synchronous implementation — the signature stays
 *    stable even if it later moves to IPC)
 *  - Streams are unified as subscribe(handler): Unsubscribe
 *  - Input and output types all come from protocol. Implementation details (WS frames, invoke
 *    names) must not leak out
 */

export * from './common.js'
export * from './agents.js'
export * from './projects.js'
export * from './fs.js'
export * from './system.js'
export * from './git.js'
export * from './history.js'
export * from './preferences.js'
export * from './terminal.js'
export * from './apps.js'
export * from './lifecycle.js'
export * from './machines.js'
export * from './mail.js'
export * from './host-requests.js'

export interface Platform {
  agents: AgentPort
  apps: AppsPort
  projects: ProjectPort
  system: SystemPort
  git: GitPort
  fs: FsPort
  search: SearchPort
  rules: ApprovalRulesPort
  consents: ProjectConsentsPort
  trash: TrashPort
  workspace: WorkspacePort
  prefs: PreferencesPort
  themes: ThemesPort
  updates: UpdatePort
  terminal: TerminalPort
  commands: CommandRunPort
  processes: ProcessPort
  machines: MachinesPort
  /** The person's side of the mailbox (#1347); a host before it answers "Unknown method" */
  mail: MailPort
  /** The calls of the limited credential waiting for the person (#1405) */
  requests: HostRequestsPort
  /** What this window tells the host about its own failures (a crashed screen) */
  diagnostics: DiagnosticsPort
  /** Present only where the host outlives the window (desktop, through the keeper — #280) */
  background?: BackgroundPort
  /** Present only in the desktop app with the keeper: relaunching into an installed update (#352) */
  relaunch?: RelaunchPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
