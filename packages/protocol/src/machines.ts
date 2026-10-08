import { z } from 'zod'

/**
 * Linked machines (remote mode as linked hosts, #82; docs/plans/remote-hub.md).
 *
 * Every machine runs one host. The host a UI is attached to (the hub) links to the hosts of other
 * machines and shows their sessions and projects with their ids qualified as `<machine>.<id>`
 * (§3.3). These are the shapes the hub tells its UI about those links.
 */

/** Lowercase, digits and hyphens, starting with a letter. Never a dot: the first dot of a qualified id ends it */
export const MACHINE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
export const MachineId = z.string().regex(MACHINE_ID_RE, 'Not a machine id')
export type MachineId = z.infer<typeof MachineId>

/**
 * Where a link stands.
 *
 *   connecting       opening the transport or waiting for the remote host's hello
 *   connected        calls and events flow
 *   unreachable      the machine or its transport cannot be reached; the hub retries on its own
 *   not_running      the machine answers, but no `centralu serve` is running there, and the hub
 *                    could not start one (`error` says why)
 *   starting         no host was running there; the hub is starting one (`centralu serve --detach`,
 *                    docs/plans/remote-hub.md §10.9 decision 7). An older window reads it as unreachable
 *   versions_differ  the two sides run different versions; nothing connects until they are aligned
 *                    or the person declines (`machines.acceptVersions`, plan §4)
 *   refused          the remote host turned the hub's hello away and asking again did not help
 */
export const MachineStatus = z.enum(['connecting', 'connected', 'unreachable', 'not_running', 'versions_differ', 'refused', 'starting'])
export type MachineStatus = z.infer<typeof MachineStatus>

export const MachineSide = z.object({
  version: z.string(),
  protocolVersion: z.number().int(),
  /** A build run from source (not from npm): there is no "newer" to compare it with (plan §4) */
  dev: z.boolean().default(false),
})
export type MachineSide = z.infer<typeof MachineSide>

/**
 * What runs a command at the other end of ssh (measured on a Windows laptop, 2026-10-05): a Unix
 * shell, Windows OpenSSH's PowerShell, or a Linux distro inside WSL on that Windows machine (WSL2
 * forwards the distro's loopback ports to Windows' loopback, so the same forward reaches it).
 */
export const RemoteShell = z.enum(['posix', 'powershell', 'wsl'])
export type RemoteShell = z.infer<typeof RemoteShell>

/** The two sides of a link, and what the version prompt says about them (plan §4) */
export const MachineVersions = z.object({
  hub: MachineSide,
  remote: MachineSide,
  /** The side to bring up to the other. Null when they match, or when a dev build is involved */
  older: z.enum(['hub', 'remote']).nullable(),
  /** Both speak one protocol. When false the link cannot connect at all until one side updates */
  compatible: z.boolean(),
  /** Both are releases of the same channel (beta, stable). Versions are only ranked within one */
  sameChannel: z.boolean().default(true),
  /** The person chose to connect without aligning (`machines.acceptVersions`); only possible when compatible */
  accepted: z.boolean().default(false),
})
export type MachineVersions = z.infer<typeof MachineVersions>

export const MachineInfo = z.object({
  id: MachineId,
  /** What the person calls it; shown as the group header in the sidebar */
  name: z.string(),
  /** What the hub hands to `ssh`: a host alias from ~/.ssh/config, or user@host */
  sshTarget: z.string(),
  shell: RemoteShell.catch('posix').default('posix'),
  /** The distro, when `shell` is `wsl` */
  wslDistro: z.string().nullable().default(null),
  /**
   * What runs in place of `centralu` on the remote, in that shell's syntax, when it is neither on
   * the PATH an ssh command gets nor at the launcher `centralu serve` keeps. Null: those two
   */
  command: z.string().nullable().default(null),
  status: MachineStatus.catch('unreachable'),
  /** Why the link is not connected, in words for the person; null when connected */
  error: z.string().nullable().default(null),
  versions: MachineVersions.nullable().default(null),
  /** When the link last completed a hello, for "last seen" */
  lastConnectedAt: z.number().nullable().default(null),
  /**
   * The local end of the forward, and whether it equals the remote host's port. App views of a
   * remote machine (phase 2) need them to match (docs/agent-host.md §4.7).
   */
  localPort: z.number().int().nullable().default(null),
  sameLocalPort: z.boolean().default(false),
  /**
   * The hub started the host there, because it found none running (plan §10.9, decision 7), and how:
   * `detached` lives on whatever happens to the link; `link_bound` runs in the link's own ssh session,
   * because that machine blocks starting a process through WMI, and ends when the link does (`note`
   * says why). Null when the host was already running. Additive; an older hub sends nothing
   */
  hostStarted: z
    .object({ how: z.enum(['detached', 'link_bound']).catch('detached'), at: z.number(), note: z.string().nullable().default(null) })
    .nullable()
    .catch(null)
    .default(null),
})
export type MachineInfo = z.infer<typeof MachineInfo>

/** One side of a managed install: a Centralu version and the Node it runs on (`current` / `previous` there) */
export const InstalledVersion = z.object({ version: z.string(), node: z.string() })
export type InstalledVersion = z.infer<typeof InstalledVersion>

/**
 * What `machines.install` did there (docs/plans/remote-hub.md §10.2): the version `current` names
 * now, the one kept as `previous` (the rollback target), the versions it removed, and folders it could
 * not remove (a Windows program still running from them). `machine` is the row after it
 */
export const MachineInstallResult = z.object({
  machine: MachineInfo,
  current: InstalledVersion,
  previous: InstalledVersion.nullable(),
  removed: z.array(z.string()).default([]),
  left: z.array(z.string()).default([]),
})
export type MachineInstallResult = z.infer<typeof MachineInstallResult>
