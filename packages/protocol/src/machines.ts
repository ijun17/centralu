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
 *   autostart  on, off or status: `machines.autostart` (§10.4), one step. It holds the machine like
 *              the others, since the entry it writes names a launcher an uninstall may be removing.
 *              Additive (#850): a build before it reads the kind as `update`
 */
export const MachineOperation = z.object({
  kind: z.enum(['install', 'update', 'rollback', 'uninstall', 'autostart']).catch('update'),
  step: z.string(),
  /** The version it brings the machine to, when there is one */
  target: z.string().nullable().default(null),
  at: z.number(),
})
export type MachineOperation = z.infer<typeof MachineOperation>

/**
 * Whether a linked machine starts its host at boot (docs/plans/remote-hub.md §10.4, owner decision 4:
 * offered per machine, off by default), as the machine said. `how` is what it uses: `systemd`, a user
 * unit on Linux; `task`, a scheduled task at sign-in on Windows and for WSL; null where it offers
 * nothing (macOS, a Linux without systemd, WSL without interop). `linger` (systemd only): whether the
 * user's manager starts at boot, or only at login because `loginctl enable-linger` needs an administrator
 */
export const MachineAutostart = z.object({
  on: z.boolean().catch(false),
  how: z.enum(['systemd', 'task']).nullable().catch(null),
  linger: z.boolean().nullable().catch(null).default(null),
})
export type MachineAutostart = z.infer<typeof MachineAutostart>

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
   * The local end of the forward, and whether it equals the remote host's port. For diagnosis only:
   * app views of a linked machine are served by the hub itself and need neither
   * (docs/plans/remote-hub.md §11).
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
  /**
   * Whether the machine starts its host at boot, from its connection line and the last
   * `machines.autostart` (`MachineAutostart`). Null when the machine has not answered, or predates it.
   * Additive
   */
  autostart: MachineAutostart.nullable().catch(null).default(null),
  /**
   * The machine's host said in its hello that it runs with administrator rights (#702): on Windows, an account in the
   * Administrators group linked over ssh gets a full token with no UAC split, so every agent there and every tool call
   * runs as an administrator. Null when the host has not said (not connected yet, or a build that predates it). Additive
   */
  elevated: z.boolean().nullable().catch(null).default(null),
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
  /** Why the version installed is not this computer's own (a local build installs its release; #689). Additive */
  note: z.string().optional(),
})
export type MachineInstallResult = z.infer<typeof MachineInstallResult>

/**
 * What `machines.uninstall` did: the row after it, and whether a host was running there that it stopped.
 * The remote's data (its store, `serve.json`, logs) stays, as `centralu uninstall` keeps history
 */
export const MachineUninstallResult = z.object({ machine: MachineInfo, stopped: z.boolean() })
export type MachineUninstallResult = z.infer<typeof MachineUninstallResult>

/** What `machines.autostart` left: the row after it, and the machine's answer */
export const MachineAutostartResult = z.object({ machine: MachineInfo, autostart: MachineAutostart })
export type MachineAutostartResult = z.infer<typeof MachineAutostartResult>

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

/*
 * What a hub's orchestrator reads about a linked machine's sessions (docs/plans/remote-hub.md §12, phase 4 step 1).
 * The machine answers with the orchestrator's own code, in its own terms (its ids, its project names), over the view
 * the hub's window has: every session but its orchestrator and coordinators. The hub qualifies the ids and names the
 * machine. Text fields are the machine's words; the hub fences them before a model reads them
 */

/** One session, as `list_sessions` shows it (`host.sessions`) */
export const HostSessionRow = z.object({
  sessionId: z.string(),
  name: z.string(),
  project: z.string(),
  state: z.string(),
  tool: z.string(),
  merged: z.boolean().optional(),
  pr: z.object({ number: z.number(), state: z.string() }).optional(),
  preview: z.string().default(''),
  lastActive: z.string().optional(),
})
export type HostSessionRow = z.infer<typeof HostSessionRow>

/** One session's conversation, as `read_session` shows it (`host.readSession`): one JSON line per message */
export const HostReadSessionResult = z.object({ state: z.string(), lines: z.array(z.string()) })
export type HostReadSessionResult = z.infer<typeof HostReadSessionResult>

/** One search hit, as `recall` shows it (`host.recall`); `seq` goes back as `host.readSession`'s `around` */
export const HostRecallHit = z.object({
  sessionId: z.string(),
  session: z.string(),
  project: z.string(),
  snippet: z.string(),
  seq: z.number(),
  at: z.string().optional(),
})
export type HostRecallHit = z.infer<typeof HostRecallHit>

/**
 * One concrete `Host` alias from the ssh config of the computer the hub runs on (#514): what
 * `machines.sshHosts` lists so the person picks a machine instead of typing it, as VS Code's
 * Remote-SSH does. `hostName`, `user` and `port` are what `ssh -G <alias>` resolves (null when it
 * could not). `linked` names the machines already linked through this alias: one Windows computer
 * can be linked twice, as Windows and as a WSL distro
 */
export const SshHost = z.object({
  alias: z.string(),
  hostName: z.string().nullable().default(null),
  user: z.string().nullable().default(null),
  port: z.number().int().nullable().default(null),
  /** Where the alias is declared, `<file>:<line>`, with the home folder as `~` */
  source: z.string().default(''),
  linked: z
    .array(z.object({ machineId: MachineId, name: z.string(), shell: RemoteShell.catch('posix'), wslDistro: z.string().nullable().default(null) }))
    .default([]),
})
export type SshHost = z.infer<typeof SshHost>

/**
 * The answer of `machines.sshHosts`: the aliases in file order (an `Include` read where it stands, as
 * OpenSSH reads it), and notes for the person about what was left out (a `Match` block, an `Include`
 * that could not be read, aliases past the cap)
 */
export const SshHostList = z.object({
  /** The file read first, with the home folder as `~` */
  configFile: z.string(),
  hosts: z.array(SshHost),
  notes: z.array(z.string()).default([]),
})
export type SshHostList = z.infer<typeof SshHostList>

/**
 * What one BatchMode ssh found at the other end of a target (`machines.probe`, #514):
 *
 *   reachable      ssh got there and ran the probe (false: `error` is ssh's own last line)
 *   os             `posix` (a Unix shell answered) or `windows` (Windows OpenSSH); null when ssh
 *                  could not get there, or what came back was not recognised (`error` says what)
 *   windowsShell   the shell Windows OpenSSH runs a command under (its `DefaultShell`; cmd.exe when
 *                  none is set). cmd.exe is the one that limits a command line to 8,191 characters
 *   wslDistros     the WSL distros registered for that account, the default one marked
 */
export const MachineProbe = z.object({
  sshTarget: z.string(),
  reachable: z.boolean(),
  os: z.enum(['posix', 'windows']).nullable().catch(null),
  windowsShell: z.enum(['cmd', 'powershell', 'pwsh', 'other']).nullable().catch(null).default(null),
  wslDistros: z.array(z.object({ name: z.string(), default: z.boolean().default(false) })).default([]),
  error: z.string().nullable().default(null),
})
export type MachineProbe = z.infer<typeof MachineProbe>
