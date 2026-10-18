import type {
  MachineAutostartResult,
  MachineConnect,
  MachineInfo,
  MachineInstallResult,
  MachineUninstallResult,
  MachineProbe,
  HostActivity,
  RemoteShell,
  SshHostList,
} from '@cc/protocol'

/**
 * Linked machines (#82, docs/plans/remote-hub.md): the hosts on other computers this computer's
 * host reaches over the person's own ssh. Adding one is the consent for this computer to reach that
 * machine (plan §3.2). Their state arrives as `machine_status` events; `machine_resync` says what the
 * UI holds about one of them has to be read again.
 */
export interface MachinesPort {
  list(): Promise<MachineInfo[]>
  add(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): Promise<MachineInfo>
  /**
   * The hosts of the ssh config of the computer the host runs on, read by the host, each marked with
   * the machines linked through it (#514). Read again each time the Add machine dialog opens
   */
  sshHosts(): Promise<SshHostList>
  /** One BatchMode ssh to tell what runs there (posix, or Windows with its shell and WSL distros) before linking it */
  probe(sshTarget: string): Promise<MachineProbe>
  /** Unlinks it: its sessions and projects leave the lists. Nothing on the machine changes */
  remove(machineId: string): Promise<void>
  /** Tries the link again now instead of waiting out its backoff; connects a disconnected one, which then stays up (#1134) */
  reconnect(machineId: string): Promise<MachineInfo>
  /** Closes the link until it is connected or needed again; the machine stays linked (#1134) */
  disconnect(machineId: string): Promise<MachineInfo>
  /** When the host opens the link: at start, or when needed (#1134) */
  setConnect(machineId: string, connect: MachineConnect): Promise<MachineInfo>
  /** This window needs the machine now: one of its projects or sessions is open (#1134). Answers at once */
  need(machineId: string): Promise<MachineInfo>
  /** Connects although the versions differ (one protocol only): the person declined to align them (plan §4) */
  acceptVersions(machineId: string): Promise<MachineInfo>
  /**
   * Installs, updates, rolls back or removes the Centralu this computer installs there over ssh
   * (docs/plans/remote-hub.md §10.5). Each answers when done or refused; its steps arrive meanwhile as
   * the machine's `operation`. Update and rollback stop the host there, and with it its agents
   */
  install(machineId: string): Promise<MachineInstallResult>
  update(machineId: string): Promise<MachineInstallResult>
  rollback(machineId: string): Promise<MachineInstallResult>
  uninstall(machineId: string): Promise<MachineUninstallResult>
  /**
   * Starts the machine's host at boot, or stops doing that, or (without `on`) reads whether it does
   * (docs/plans/remote-hub.md §10.4). Nothing starts or stops now; the row's `autostart` follows
   */
  autostart(machineId: string, on?: boolean): Promise<MachineAutostartResult>
  /** What would stop there if its host stopped now; null when the machine cannot say */
  activity(machineId: string): Promise<HostActivity | null>
}
