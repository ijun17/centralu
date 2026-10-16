import type { AgentPort } from './agents'
import type { AppsPort } from './apps'
import type { FsPort } from './fs'
import type { GitPort } from './git'
import type { ApprovalRulesPort, SearchPort, TrashPort } from './history'
import type { BackgroundPort, ProcessPort, RelaunchPort, UpdatePort } from './lifecycle'
import type { MachinesPort } from './machines'
import type { PreferencesPort, ThemesPort, WorkspacePort } from './preferences'
import type { ProjectConsentsPort, ProjectPort } from './projects'
import type { PlatformCapabilities, SystemPort } from './system'
import type { CommandRunPort, TerminalPort } from './terminal'

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

export * from './common'
export * from './agents'
export * from './projects'
export * from './fs'
export * from './system'
export * from './git'
export * from './history'
export * from './preferences'
export * from './terminal'
export * from './apps'
export * from './lifecycle'
export * from './machines'

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
  /** Present only where the host outlives the window (desktop, through the keeper — #280) */
  background?: BackgroundPort
  /** Present only in the desktop app with the keeper: relaunching into an installed update (#352) */
  relaunch?: RelaunchPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
