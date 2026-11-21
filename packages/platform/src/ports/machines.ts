import type {
  MachineAskConsent,
  MachineAutostartResult,
  MachineInfo,
  MachineInstallResult,
  MachineUninstallResult,
  MachineProbe,
  HostActivity,
  RemoteShell,
  SshHostList,
} from '@cc/protocol/client'

/**
 * Hosts on other computers reached over the person's own ssh (#82, docs/plans/remote-hub.md, docs/protocol.md §3).
 * Adding one is the consent to reach it (plan §3.2).
 */
export interface MachinesPort {
  list(): Promise<MachineInfo[]>
  add(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): Promise<MachineInfo>
  sshHosts(): Promise<SshHostList>
  /** One BatchMode ssh telling what runs there (posix, or Windows with its shell and WSL distros) */
  probe(sshTarget: string): Promise<MachineProbe>
  /** Its sessions and projects leave the lists; nothing on the machine changes */
  remove(machineId: string): Promise<void>
  /** Skips the backoff; connects a disconnected one (#1134), the only retry with Auto reconnect off (#1341) */
  reconnect(machineId: string): Promise<MachineInfo>
  disconnect(machineId: string): Promise<MachineInfo>
  revokeCredential(machineId: string, credentialId: string): Promise<MachineInfo>
  /** Off (#1341): the host tries once when it starts, then only when the person connects it */
  setAutoReconnect(machineId: string, autoReconnect: boolean): Promise<MachineInfo>
  /** Connects despite differing versions (one protocol only): the person declined to align them (plan §4) */
  acceptVersions(machineId: string): Promise<MachineInfo>
  /**
   * docs/plans/remote-hub.md §10.5. Each answers when done or refused; steps come as the machine's `operation`. Update
   * and rollback stop the host there, and its agents with it
   */
  install(machineId: string): Promise<MachineInstallResult>
  update(machineId: string, opts?: { when?: 'idle' | 'now' }): Promise<MachineInstallResult>
  /** Ends the wait for idle: the update fails saying so, nothing switched (#1399) */
  cancelUpdate(machineId: string): Promise<MachineInfo>
  rollback(machineId: string): Promise<MachineInstallResult>
  uninstall(machineId: string): Promise<MachineUninstallResult>
  /** Start at boot, or not, or read it without `on` (plan §10.4). Nothing starts or stops now */
  autostart(machineId: string, on?: boolean): Promise<MachineAutostartResult>
  /** What would stop there if its host stopped now; null when the machine cannot say */
  activity(machineId: string): Promise<HostActivity | null>
  hubAuto(machineId: string, allowed?: boolean): Promise<'on' | 'off' | 'older' | 'unreachable'>
  setAsks(machineId: string, on: boolean): Promise<MachineInfo>
  askConsents(): Promise<MachineAskConsent[]>
  withdrawAsk(machineId: string, sessionId: string, projectId: string): Promise<void>
}
