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
 *   updating         the hub is stopping, switching or removing the Centralu it installed there
 *                    (`machines.update` / `rollback` / `uninstall`; `operation` says which step). The
 *                    link waits meanwhile. An older window reads it as unreachable
 */
export const MachineStatus = z.enum(['connecting', 'connected', 'unreachable', 'not_running', 'versions_differ', 'refused', 'starting', 'updating'])
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

/** One side of a managed install: a Centralu version and the Node it runs on (`current` / `previous` there) */
export const InstalledVersion = z.object({ version: z.string(), node: z.string() })
export type InstalledVersion = z.infer<typeof InstalledVersion>

/**
 * A step of what the hub does to the Centralu it installs on a machine (docs/plans/remote-hub.md §10.5):
 *
 *   install    preflight, registry, node, centralu (install.ts)
 *   update     those, then stop (the running host, `serve --stop`), switch (`current`), start
 *              (`serve --detach`), check (a hello from the new version within 30 s), then prune, or
 *              roll_back when the check failed
 *   rollback   stop, switch, start, check
 *   uninstall  stop, remove
 */
export const MachineOperation = z.object({
  kind: z.enum(['install', 'update', 'rollback', 'uninstall']).catch('update'),
  step: z.string(),
  /** The version it brings the machine to, when there is one */
  target: z.string().nullable().default(null),
  at: z.number(),
})
export type MachineOperation = z.infer<typeof MachineOperation>

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
  /**
   * What the hub installed there, as the remote's connection line last said (docs/plans/remote-hub.md
   * §10.5, S12): `managed` when the running `centralu` is that install, `current` and `previous` (the
   * rollback target) from its pointer files. Null when the machine has not answered, or predates the
   * field. Additive
   */
  install: z
    .object({ managed: z.boolean().catch(false), current: InstalledVersion.nullable().catch(null), previous: InstalledVersion.nullable().catch(null) })
    .nullable()
    .catch(null)
    .default(null),
  /**
   * An install, update, rollback or uninstall the hub is running there, and its step, while it runs
   * (`machines.install` / `update` / `rollback` / `uninstall`). Null otherwise. Additive
   */
  operation: MachineOperation.nullable().catch(null).default(null),
})
export type MachineInfo = z.infer<typeof MachineInfo>

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

/**
 * What `machines.uninstall` did: the row after it, and whether a host was running there that it stopped.
 * The remote's data (its store, `serve.json`, logs) stays, as `centralu uninstall` keeps history
 */
export const MachineUninstallResult = z.object({ machine: MachineInfo, stopped: z.boolean() })
export type MachineUninstallResult = z.infer<typeof MachineUninstallResult>

/**
 * What would stop if a host stopped now (the `hostBusy` rule, docs/agent-host.md): its live sessions
 * that are working, waiting on an approval, asking a question, or running background work, its open
 * terminals and its running project commands. `host.activity` answers it about one host. A remote
 * host has no keeper today (plan §10.4), so stopping it ends all of these
 */
export const HostActivity = z.object({
  working: z.number().int().default(0),
  approvals: z.number().int().default(0),
  questions: z.number().int().default(0),
  background: z.number().int().default(0),
  terminals: z.number().int().default(0),
  commandRuns: z.number().int().default(0),
})
export type HostActivity = z.infer<typeof HostActivity>
