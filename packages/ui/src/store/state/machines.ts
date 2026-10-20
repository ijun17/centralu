import type {
  AgentVersions,
  HostActivity,
  MachineInfo,
  MachineProbe,
  RemoteShell,
  SshHostList,
} from '@cc/protocol'

/** Linked machines (#82). */
export type MachinesSlice = {
  /**
   * The machines this computer's host is linked to (#82, docs/plans/remote-hub.md), by id, in the
   * order the host lists them. Each row is replaced whole by its `machine_status`. Empty with no
   * links, and with a host from before them.
   */
  machines: Record<string, MachineInfo>
  /** The agent CLIs installed on each linked machine (#297 per machine), read when a remote session's header asks */
  machineAgentVersions: Record<string, AgentVersions>
  refreshMachines(): Promise<void>
  /**
   * The recovery `machine_resync` asks for, scoped to one machine (#82): re-read the session and
   * project lists and replace that machine's rows only, re-read the conversations of its sessions
   * that are open, and wake only its sessions that were live and are not now. Every other machine's
   * rows, and this computer's, are left exactly as they are.
   */
  recoverMachine(machineId: string): Promise<void>
  addMachine(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): Promise<MachineInfo>
  /**
   * The hosts of the ssh config of the computer the host runs on (#514), for the Add machine dialog.
   * Null when the host cannot say (an older host): the dialog then asks for a target by hand
   */
  machineSshHosts(): Promise<SshHostList | null>
  /** What runs at the other end of a target, asked over one BatchMode ssh (#514); null when the host cannot ask */
  probeMachine(sshTarget: string): Promise<MachineProbe | null>
  removeMachine(machineId: string): Promise<void>
  reconnectMachine(machineId: string): Promise<void>
  /** Closes the machine's link until the person connects it again; it stays linked (#1134). A refusal is a toast */
  disconnectMachine(machineId: string): Promise<void>
  /** Auto reconnect on or off for the machine (#1341); false (with a toast) when the host refused */
  setMachineAutoReconnect(machineId: string, autoReconnect: boolean): Promise<boolean>
  acceptMachineVersions(machineId: string): Promise<void>
  /**
   * Installs, updates, rolls back or removes the Centralu this computer installs on a machine
   * (docs/plans/remote-hub.md §10.5). True when it was done; a refusal or failure is a toast in the
   * host's words (an update that did not take says which version runs there now)
   */
  changeMachineInstall(machineId: string, kind: 'install' | 'update' | 'rollback' | 'uninstall'): Promise<boolean>
  /** Starts a machine's host at boot, or stops doing that (plan §10.4); false (with a toast) when it was refused */
  setMachineAutostart(machineId: string, on: boolean): Promise<boolean>
  /** Lets a machine's sessions ask this computer's projects, or stops it (#550); false (with a toast) when it was refused */
  setMachineAsks(machineId: string, on: boolean): Promise<boolean>
  /** What would stop on a machine if its host stopped now, for the update prompt; null when unknown */
  machineActivity(machineId: string): Promise<HostActivity | null>
  checkMachineAgentVersions(machineId: string, force?: boolean): Promise<void>
}
