import type { MachineSide, NormalizedEvent } from '@cc/protocol'
import type { RemoteRuntime } from './install.js'
import type { RegistryOptions } from './registry.js'
import type { RemoteClientOptions } from './remote-client.js'
import type { RemoteSpec, Tunnel } from './tunnel.js'

/** What the hub's links are given (links.ts): the registry, the mirror, the tunnels and the installer */

/** One linked machine as the registry keeps it (store: `linked_machines`) */
export type MachineRecord = {
  id: string
  name: string
  sshTarget: string
  /** The remote's shell, and what runs in place of `centralu` there (tunnel.ts) */
  remote: RemoteSpec
  /** The machine's number for folding numeric ids (machine-ids.ts). Never reused while the row exists */
  slot: number
  addedAt: number
  /** The version pair the person chose to connect without aligning, if any (versions.ts) */
  acceptedVersions: string | null
  /** Whether this machine's sessions may ask this computer's projects (#550); off when absent */
  asks?: boolean
  /** Auto reconnect (#1341); absent: on */
  autoReconnect?: boolean
}

export interface MachineRegistry {
  list(): MachineRecord[]
  add(record: Omit<MachineRecord, 'slot'>): MachineRecord
  remove(id: string): void
  setAcceptedVersions(id: string, key: string | null): void
  /** The reverse direction's switch (#550); off also forgets the machine's approved pairs */
  setAsks?(id: string, on: boolean): void
  setAutoReconnect(id: string, autoReconnect: boolean): void
}

/**
 * What answers a linked machine's call to this hub (#550, the reverse direction): the machine is the link's own, never
 * what the call says; `signal` fires when the machine withdraws the call or its link goes
 */
export type ReverseCalls = (machine: { id: string; name: string }, method: string, params: unknown, signal: AbortSignal) => Promise<unknown>

/**
 * What the hub last heard from a machine, for when it cannot ask (mirror.ts): the session and
 * project headers in the remote's own terms, never a conversation.
 */
export interface HeadersMirror {
  read(machine: string, kind: 'sessions' | 'projects'): unknown[] | null
  replace(machine: string, kind: 'sessions' | 'projects', list: unknown[]): void
  upsertSession(machine: string, session: Record<string, unknown>): void
  patchSession(machine: string, sessionId: string, patch: Record<string, unknown>): void
  removeSession(machine: string, sessionId: string): void
  forget(machine: string): void
}

export type LinkDeps = {
  hub: MachineSide
  /** Into the hub's own event log, under the hub's sequence numbers */
  broadcast: (event: NormalizedEvent) => void
  /** Into the hub's own terminal lane */
  terminal: (frame: { terminalId: string; data?: string; exitCode?: number | null }) => void
  mirror: HeadersMirror
  registry: MachineRegistry
  tunnelFor: (record: MachineRecord) => Tunnel
  log?: (line: string) => void
  /**
   * The hub's session a linked machine's session is a child of (#1038, `SessionManager.remoteAgentParent`), by its
   * hub-side id; none for a session no session here started. Its rows reach the windows with that parent as `askedBy`
   */
  ownerOf?: (sessionId: string) => string | undefined
  /**
   * The reverse direction (#550): this hub's own id and name, which it offers a machine whose switch is on
   * (`host.hubOffer`), and what answers that machine's calls. Without them no machine is offered anything, and a call
   * from one is dropped, as before the reverse direction existed
   */
  hubSelf?: () => { id: string; name: string }
  reverse?: ReverseCalls
  /** For tests: the client's options beyond url and token */
  client?: Partial<RemoteClientOptions>
  /** Backoff between attempts while a machine is away; doubles up to the second value (2 s to 5 minutes when absent) */
  retryMs?: [number, number]
  /** For tests: how long a link held at `versions_differ` waits before it looks at the versions again (60 s when absent) */
  versionsRetryMs?: number
  /** For tests: how long a host stays up before the backoff starts over (60 s when absent, #1143) */
  stableMs?: number
  /** For tests: at most `max` hosts the link starts by itself within `windowMs` (3 in 10 minutes when absent, #1143) */
  restarts?: { max: number; windowMs: number }
  /** What `machines.install` sends (install.ts). Without it this hub installs nothing */
  installer?: LinkInstaller
  /** For tests: how long an updated host has to answer (update.ts `CHECK_MS`) */
  checkMs?: number
  /**
   * For tests: the ssh binary, config file and home folder `machines.sshHosts` and `machines.probe` use
   * in place of the person's own (ssh-config.ts, probe.ts)
   */
  ssh?: { ssh?: string; configFile?: string; home?: string; env?: NodeJS.ProcessEnv }
}

export type LinkInstaller = {
  /** The pinned Node (`remote-runtime.json`) */
  runtime: () => RemoteRuntime
  /** `remote-install.mjs`'s text */
  script: () => string
  registry?: RegistryOptions
  nodeDist?: string
}
