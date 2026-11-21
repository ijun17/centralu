import { z } from 'zod'
import { HostHandover, HostLogon } from './host-logon.js'

/** What a hub tells its UI about its links to other machines' hosts (docs/protocol.md §6, docs/plans/remote-hub.md). */

/** Never a dot: the first dot of a qualified id ends the machine id */
export const MACHINE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
export const MachineId = z.string().regex(MACHINE_ID_RE, 'Not a machine id')
export type MachineId = z.infer<typeof MachineId>

/** A linked machine a hub's merged answer could not read just now (`trash.list`, `mail.tasks`) */
export const UnreachedMachine = z.object({ machineId: z.string(), name: z.string() })
export type UnreachedMachine = z.infer<typeof UnreachedMachine>

/**
 * Where a link stands (docs/protocol.md §6 `MachineInfo`). What that list does not say:
 *   unreachable  the machine refused ssh (a key, a host key) or the link ended; one that does not answer at all is
 *                `away`, and stays `away` between attempts that fail the same way
 *   refused      the remote host turned the hub's hello away and asking again did not help
 *   updating     the hub is stopping, switching or removing the Centralu it installed there (`operation` says the
 *                step); an older window reads it as unreachable
 */
export const MachineStatus = z.enum([
  'connecting',
  'connected',
  'unreachable',
  'away',
  'not_running',
  'versions_differ',
  'refused',
  'starting',
  'updating',
  'disconnected',
  'stopped',
])
export type MachineStatus = z.infer<typeof MachineStatus>

export const MachineSide = z.object({
  version: z.string(),
  protocolVersion: z.number().int(),
  /** A build run from source: there is no "newer" to compare it with */
  dev: z.boolean().default(false),
})
export type MachineSide = z.infer<typeof MachineSide>

/** `wsl`: a distro on Windows, reached by the same forward since WSL2 forwards its loopback ports (measured) */
export const RemoteShell = z.enum(['posix', 'powershell', 'wsl'])
export type RemoteShell = z.infer<typeof RemoteShell>

export const MachineVersions = z.object({
  hub: MachineSide,
  remote: MachineSide,
  /** The side to bring up to the other. Null when they match, or when a dev build is involved */
  older: z.enum(['hub', 'remote']).nullable(),
  /** False: the link cannot connect at all until one side updates */
  compatible: z.boolean(),
  /** Versions are only ranked within one channel (beta, stable) */
  sameChannel: z.boolean().default(true),
  /** Only possible when compatible */
  accepted: z.boolean().default(false),
})
export type MachineVersions = z.infer<typeof MachineVersions>

/** A dev build made on that machine from a commit (`pnpm remote-dev`); its version is `<base>.local.N` */
export const InstallSource = z.object({
  kind: z.literal('dev'),
  commit: z.string(),
  dirty: z.boolean().catch(false).default(false),
})
export type InstallSource = z.infer<typeof InstallSource>

export const InstalledVersion = z.object({
  version: z.string(),
  node: z.string(),
  source: InstallSource.optional().catch(undefined),
})
export type InstalledVersion = z.infer<typeof InstalledVersion>

/**
 * A step of what the hub does to the Centralu it installs on a machine (docs/plans/remote-hub.md §10.5). `autostart`
 * holds the machine like the others, since the entry it writes names a launcher an uninstall may be removing; a build
 * before it reads the kind as `update`
 */
export const MachineOperation = z.object({
  kind: z.enum(['install', 'update', 'rollback', 'uninstall', 'autostart']).catch('update'),
  /** install: preflight, registry, node, centralu; update adds stop, switch, start, check, then prune or roll_back */
  step: z.string(),
  target: z.string().nullable().default(null),
  at: z.number(),
  /** How many `wait_idle` (sessions in a turn) or `wait_open` (open terminals and project commands) waits for */
  count: z.number().optional(),
})
export type MachineOperation = z.infer<typeof MachineOperation>

/**
 * Whether a linked machine starts its host at boot (docs/plans/remote-hub.md §10.4), as the machine said. `how`:
 * `systemd`, a user unit; `task`, a scheduled task at sign-in (Windows, WSL); null where it offers nothing (macOS, a
 * Linux without systemd, WSL without interop). `linger` false: only at login, since `loginctl enable-linger` needs an
 * administrator
 */
export const MachineAutostart = z.object({
  on: z.boolean().catch(false),
  how: z.enum(['systemd', 'task']).nullable().catch(null),
  linger: z.boolean().nullable().catch(null).default(null),
})
export type MachineAutostart = z.infer<typeof MachineAutostart>

/** The fields not noted here are in docs/protocol.md §6 `MachineInfo` and §3's `machines` row */
export const MachineInfo = z.object({
  id: MachineId,
  name: z.string(),
  /** A host alias from ~/.ssh/config, or user@host */
  sshTarget: z.string(),
  shell: RemoteShell.catch('posix').default('posix'),
  wslDistro: z.string().nullable().default(null),
  /** Runs in place of `centralu`, in that shell's syntax, when it is neither on ssh's PATH nor at serve's launcher */
  command: z.string().nullable().default(null),
  status: MachineStatus.catch('unreachable'),
  /** In words for the person; null when connected */
  error: z.string().nullable().default(null),
  versions: MachineVersions.nullable().default(null),
  lastConnectedAt: z.number().nullable().default(null),
  nextAttemptAt: z.number().nullable().catch(null).default(null),
  /** For diagnosis only: the hub serves a linked machine's app views itself (docs/plans/remote-hub.md §11) */
  localPort: z.number().int().nullable().default(null),
  sameLocalPort: z.boolean().default(false),
  hostStarted: z
    .object({
      how: z.enum(['detached', 'link_bound']).catch('detached'),
      at: z.number(),
      note: z.string().nullable().default(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  /** From the connection line: `managed` when the running `centralu` is that install; `previous` is the rollback target */
  install: z
    .object({
      managed: z.boolean().catch(false),
      current: InstalledVersion.nullable().catch(null),
      previous: InstalledVersion.nullable().catch(null),
    })
    .nullable()
    .catch(null)
    .default(null),
  operation: MachineOperation.nullable().catch(null).default(null),
  /** From the connection line and the last `machines.autostart`; null before the machine answered */
  autostart: MachineAutostart.nullable().catch(null).default(null),
  /** On Windows an administrator linked over ssh gets a full token, no UAC split: every agent there runs elevated */
  elevated: z.boolean().nullable().catch(null).default(null),
  /** Whether this machine's sessions may ask this computer's projects (remote-hub.md §12.7); `note`: why not, while on */
  asks: z
    .object({ on: z.boolean().catch(false), note: z.string().nullable().catch(null).default(null) })
    .nullable()
    .catch(null)
    .default(null),
  logon: HostLogon.nullable().catch(null).default(null),
  /** From the host's hello and its `host_handover` events */
  handover: HostHandover.nullable().catch(null).default(null),
  /** Absent from an older hub, which reads as on */
  autoReconnect: z.boolean().catch(true).default(true),
  /** An older hub sends nothing and stops at once, so a window must not promise a wait without this */
  updateWaits: z.boolean().optional(),
  /** How a switch the machine ran itself ended, when this hub did not follow it (remote-hub.md §10.5a); said once */
  switchNote: z.string().nullable().catch(null).optional(),
  /** `retryAt` null: no retry for this version, though the person's Update still can */
  followHub: z
    .object({ version: z.string(), failed: z.string(), retryAt: z.number().nullable().catch(null) })
    .nullable()
    .optional()
    .catch(undefined),
  /**
   * Never their values. `gone`: withdrawn, but something said hello with it first (or the host told the hub of it as it
   * let it in), so a use between two reads still shows, also while the link is away; it offers nothing to withdraw
   */
  otherCredentials: z
    .array(
      z.object({
        id: z.string().max(16),
        label: z.string().max(80),
        created: z.number(),
        replaced: z.boolean().catch(false).default(false),
        hubsName: z.boolean().catch(false).default(false),
        gone: z.boolean().optional().catch(undefined),
      }),
    )
    .max(32)
    .nullable()
    .catch(null)
    .default(null),
  otherCredentialsMore: z.number().int().min(0).catch(0).default(0),
  /** The host there then closes the link; the mark stays while this hub runs, so the link coming back hides nothing */
  ownCredentialGone: z.boolean().catch(false).default(false),
  /** Its host then refuses every new full hello and closes the links in with one, so this hub cannot pair again */
  credentialFileUnreadable: z.boolean().catch(false).default(false),
})
export type MachineInfo = z.infer<typeof MachineInfo>

/**
 * A pair the person approved for the reverse direction: that session may ask that project with no card, until withdrawn
 * (`machines.withdrawAsk`) or the machine's switch goes off. `sessionName` is as it was when approved
 */
export const MachineAskConsent = z.object({
  machineId: MachineId,
  machineName: z.string(),
  /** Not qualified */
  sessionId: z.string(),
  sessionName: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  decidedAt: z.number(),
})
export type MachineAskConsent = z.infer<typeof MachineAskConsent>

/** `left`: folders `machines.install` could not remove (a Windows program still running from them) */
export const MachineInstallResult = z.object({
  machine: MachineInfo,
  current: InstalledVersion,
  previous: InstalledVersion.nullable(),
  removed: z.array(z.string()).default([]),
  left: z.array(z.string()).default([]),
  /** Why the version installed is not this computer's own (a local build installs its release) */
  note: z.string().optional(),
})
export type MachineInstallResult = z.infer<typeof MachineInstallResult>

/** The remote's data (its store, `serve.json`, logs) stays, as `centralu uninstall` keeps history */
export const MachineUninstallResult = z.object({ machine: MachineInfo, stopped: z.boolean() })
export type MachineUninstallResult = z.infer<typeof MachineUninstallResult>

export const MachineAutostartResult = z.object({ machine: MachineInfo, autostart: MachineAutostart })
export type MachineAutostartResult = z.infer<typeof MachineAutostartResult>

/** What stopping a host would end (`hostBusy`, docs/agent-host/lifecycle/updates.md); a remote one has no keeper */
export const HostActivity = z.object({
  working: z.number().int().default(0),
  approvals: z.number().int().default(0),
  questions: z.number().int().default(0),
  background: z.number().int().default(0),
  terminals: z.number().int().default(0),
  commandRuns: z.number().int().default(0),
})
export type HostActivity = z.infer<typeof HostActivity>

/**
 * Leaves out terminals and project commands: they are kept open for hours, and an update that waited for them would
 * wait for good. Null (the host cannot say) counts none
 */
export function turnsRunning(a: HostActivity | null | undefined): number {
  return a ? a.working + a.approvals + a.questions + a.background : 0
}

/*
 * What a hub's Assistant reads about a linked machine's sessions (docs/plans/remote-hub.md §12), in the machine's own
 * terms. Text fields are the machine's words; the hub fences them before a model reads them
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
export const HostReadSessionResult = z.object({
  state: z.string(),
  lines: z.array(z.string()),
  /** The budget the machine fitted these lines to; absent from one that does not, and the hub bounds them itself */
  maxChars: z.number().int().optional(),
})
export type HostReadSessionResult = z.infer<typeof HostReadSessionResult>

/**
 * A session's last response, whole (`host.lastAnswer`): `host.readSession` cuts lines at 2,000 characters, so a long
 * answer read from it comes back as an older line or nothing. `seq` is its first message's, for `around`
 */
export const HostLastAnswerResult = z.object({
  text: z.string(),
  length: z.number().int().min(0),
  seq: z.number().int().nullable(),
})
export type HostLastAnswerResult = z.infer<typeof HostLastAnswerResult>

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
 * A concrete `Host` alias from the hub's ssh config, so the person picks a machine instead of typing it. `hostName`,
 * `user` and `port` are what `ssh -G <alias>` resolves. One Windows computer can be linked twice: as Windows and as a
 * WSL distro
 */
export const SshHost = z.object({
  alias: z.string(),
  hostName: z.string().nullable().default(null),
  user: z.string().nullable().default(null),
  port: z.number().int().nullable().default(null),
  /** `<file>:<line>`, with the home folder as `~` */
  source: z.string().default(''),
  linked: z
    .array(
      z.object({
        machineId: MachineId,
        name: z.string(),
        shell: RemoteShell.catch('posix'),
        wslDistro: z.string().nullable().default(null),
      }),
    )
    .default([]),
})
export type SshHost = z.infer<typeof SshHost>

/**
 * The aliases in file order (an `Include` read where it stands, as OpenSSH reads it), and notes on what was left out (a
 * `Match` block, an `Include` that could not be read, aliases past the cap)
 */
export const SshHostList = z.object({
  /** With the home folder as `~` */
  configFile: z.string(),
  hosts: z.array(SshHost),
  notes: z.array(z.string()).default([]),
})
export type SshHostList = z.infer<typeof SshHostList>

/**
 * What one BatchMode ssh found at the other end of a target (`machines.probe`). `error` is ssh's own last line, or what
 * was not recognised. `windowsShell` is Windows OpenSSH's `DefaultShell` (cmd.exe when none is set): cmd.exe limits a
 * command line to 8,191 characters
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
