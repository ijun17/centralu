import type {
  AgentVersions,
  HostActivity,
  MachineInfo,
  MachineProbe,
  RemoteShell,
  SshHostList,
} from '@cc/protocol/client'

/** Linked machines (#82). */
export type MachinesSlice = {
  /** docs/state-management.md §7: by id, in the host's order, each replaced whole by its `machine_status`. */
  machines: Record<string, MachineInfo>
  /** Read when a remote session's header asks (#297) */
  machineAgentVersions: Record<string, AgentVersions>
  refreshMachines(): Promise<void>
  /** `machine_resync`'s recovery, scoped to that machine's rows: docs/state-management.md §7. */
  recoverMachine(machineId: string): Promise<void>
  addMachine(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): Promise<MachineInfo>
  /** The host computer's ssh config hosts (#514); null from an older host, and the dialog asks for a target by hand */
  machineSshHosts(): Promise<SshHostList | null>
  /** Asked over one BatchMode ssh (#514); null when the host cannot ask */
  probeMachine(sshTarget: string): Promise<MachineProbe | null>
  removeMachine(machineId: string): Promise<void>
  reconnectMachine(machineId: string): Promise<void>
  /** Closes the link until the person connects again; it stays linked (#1134) */
  disconnectMachine(machineId: string): Promise<void>
  /** One of the machine's other full credentials (#1405) */
  revokeMachineCredential(machineId: string, credentialId: string): Promise<void>
  /** (#1341) false, with a toast, when refused */
  setMachineAutoReconnect(machineId: string, autoReconnect: boolean): Promise<boolean>
  acceptMachineVersions(machineId: string): Promise<void>
  /** docs/plans/remote-hub.md §10.5. A refusal is toasted in the host's words (a failed update names the running version) */
  changeMachineInstall(machineId: string, kind: 'install' | 'update' | 'rollback' | 'uninstall', when?: 'idle' | 'now'): Promise<boolean>
  /** Ends an update's wait for the machine's sessions to finish (#1399) */
  cancelMachineUpdate: (machineId: string) => Promise<void>
  /** docs/plans/remote-hub.md §10.4; false, with a toast, when refused */
  setMachineAutostart(machineId: string, on: boolean): Promise<boolean>
  /** Lets a machine's sessions ask this computer's projects (#550); false, with a toast, when refused */
  setMachineAsks(machineId: string, on: boolean): Promise<boolean>
  /** What would stop if the machine's host stopped now; null when unknown */
  machineActivity(machineId: string): Promise<HostActivity | null>
  checkMachineAgentVersions(machineId: string, force?: boolean): Promise<void>
}
