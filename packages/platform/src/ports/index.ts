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

// The only outside world ui knows; the port signature rules are docs/platform-abstraction.md §2

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
  mail: MailPort
  requests: HostRequestsPort
  diagnostics: DiagnosticsPort
  /** Only where the host outlives the window (desktop, through the keeper, #280) */
  background?: BackgroundPort
  /** Only in the desktop app, with or without the keeper (#352) */
  relaunch?: RelaunchPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
