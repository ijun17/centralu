import { isInTurn, MIN_SUPPORTED_VERSION, releaseOf, turnsRunning, type HostActivity, type MachineInfo, type MachineStatus } from '@cc/protocol/client'

/**
 * Linked machines on the screen (#82, docs/plans/remote-hub.md): which rows are away, what a link's state and last
 * error mean in words a person can act on, and what the version prompt offers.
 */

type Placed = { machine?: string | null; unreachable?: boolean }

/**
 * The one place that decides it, by the machine's own `machine_status` row (#1611); a machine with no row yet is not
 * away. Row dimming, tooltips and the machine badge all read it.
 */
export function machineAway(machine: Pick<MachineInfo, 'status'> | undefined): boolean {
  return machine !== undefined && machine.status !== 'connected'
}

/**
 * Away rows stay listed and dimmed and are never woken: `machine_resync` wakes them once the machine is back. The row's
 * `unreachable` mark is not read: it is about one answer and outlives the outage when a list read lands late (#1611).
 */
export function isAway(row: Placed | undefined, machines: Readonly<Record<string, MachineInfo>>): boolean {
  return !!row?.machine && machineAway(machines[row.machine])
}

/**
 * The one rule for waking rows a reconnect found asleep, for a host and a linked machine (#1611, #1618, #2163). Not a
 * mirrored row, nor an away machine's, nor one in a turn with no process: an update cut it, and its host continues it.
 */
export function wakeable(
  row: (Placed & { live?: boolean; state?: unknown }) | undefined,
  machines: Readonly<Record<string, MachineInfo>>,
): boolean {
  return !!row && !row.live && !row.unreachable && !isAway(row, machines) && !isInTurn(row.state)
}

/** The mark a connected machine's row kept from an older answer does not count (#1611) */
export function isMirrored(row: Placed | undefined, machines: Readonly<Record<string, MachineInfo>>): boolean {
  return row?.unreachable === true && isAway(row, machines)
}

export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  connected: 'connected',
  connecting: 'connecting',
  unreachable: 'away',
  away: 'away',
  not_running: 'not running',
  versions_differ: 'version mismatch',
  refused: 'refused',
  starting: 'starting',
  updating: 'updating',
  disconnected: 'disconnected',
  stopped: 'stopped',
}

export type MachineProblem = {
  title: string
  /** A command in it is quoted with backticks */
  fix: string | null
}

/** ssh's last line (`links/tunnel.ts`) turned into the one step that fixes it (#82); anything else shown as said */
export function machineProblem(m: Pick<MachineInfo, 'status' | 'error' | 'name' | 'sshTarget'> & Partial<Pick<MachineInfo, 'shell' | 'autoReconnect'>>): MachineProblem | null {
  // Disconnected on purpose (#1134)
  if (m.status === 'connected' || m.status === 'disconnected') return null
  const e = m.error ?? ''
  if ((m.status === 'connecting' || m.status === 'starting') && !e) return null
  if (m.status === 'versions_differ') return { title: e || `${m.name} runs another version of Centralu`, fix: null }
  // A state, not an error (#1398); `awayNote` says when it tries again, so trying is not said twice
  if (m.status === 'away') return { title: `${m.name} is not reachable: asleep, off or off the network`, fix: m.autoReconnect === false ? tries(m) : null }
  // By the person or after its hosts kept stopping (#1143)
  if (m.status === 'stopped') return { title: e || `Centralu is stopped on ${m.name}`, fix: 'Press Start to start it there' }
  if (m.status === 'not_running') {
    return {
      title: e || `Centralu is installed on ${m.name}, but it is not serving`,
      fix: `Run \`${shims(m).centralu} serve --detach\` on ${m.name} (it keeps running after you log out), then reconnect`,
    }
  }
  if (/not installed on/i.test(e)) {
    return { title: `Centralu is not installed on ${m.name}`, fix: `Install it there with \`${shims(m).npm} i -g centralu\`, then run \`${shims(m).centralu} serve\` once` }
  }
  if (/Permission denied/i.test(e)) {
    return {
      title: `${m.name} did not accept your ssh key`,
      fix: `Your key is probably not loaded: run \`ssh-add\` in a terminal (or add the key to ~/.ssh/config), then reconnect`,
    }
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) {
    return {
      title: `${m.name}'s host key changed since you last connected`,
      fix: `If you expected that, remove the old key with \`ssh-keygen -R <host>\`, then run \`ssh ${m.sshTarget}\` once in a terminal`,
    }
  }
  if (/Host key verification failed|host key for .* is not known|No .*host key is known/i.test(e)) {
    return {
      title: `This computer does not know ${m.name}'s host key yet`,
      fix: `Run \`ssh ${m.sshTarget}\` once in a terminal and answer yes, then reconnect`,
    }
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(e)) {
    return { title: `The name ${m.sshTarget} does not resolve to a machine`, fix: 'Check the ssh target: a host alias from ~/.ssh/config, or user@host' }
  }
  if (/Connection refused/i.test(e)) {
    return { title: `${m.name} refused the ssh connection`, fix: 'Its ssh server may be off: turn on Remote Login (macOS) or the OpenSSH server there' }
  }
  if (/timed out|No route to host|Network is unreachable|Host is down/i.test(e)) {
    return { title: `${m.name} does not answer`, fix: `It may be asleep, off or on another network. ${tries(m)}` }
  }
  if (m.status === 'refused') return { title: e || `${m.name} refused the link`, fix: `Restart \`${shims(m).centralu} serve\` there, then reconnect` }
  return e ? { title: e, fix: null } : { title: `${m.name} is away`, fix: tries(m) }
}

/** The host keeps trying only while Auto reconnect is on (#1341) */
function tries(m: Partial<Pick<MachineInfo, 'autoReconnect'>>): string {
  return m.autoReconnect === false ? 'Auto reconnect is off: press Connect to try again' : 'Centralu keeps trying'
}

export function formatAgo(when: number, now: number): string {
  const min = Math.floor((now - when) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/** Under an away row's headline (#1398); the raw ssh line is `error`, shown as details */
export function awayNote(m: Pick<MachineInfo, 'lastConnectedAt' | 'nextAttemptAt'>, now: number): { lastConnected: string | null; next: string | null } {
  const inMin = (ms: number) => {
    const min = Math.ceil(ms / 60_000)
    return min <= 1 ? 'in under a minute' : `in ${min} min`
  }
  return {
    lastConnected: m.lastConnectedAt ? formatAgo(m.lastConnectedAt, now) : null,
    next: m.nextAttemptAt && m.nextAttemptAt > now ? inMin(m.nextAttemptAt - now) : null,
  }
}

/**
 * A host this computer started there (docs/plans/remote-hub.md §10.9, decision 7): in the background, or only while
 * linked where Windows blocks that. `note`: why, or that it installed its own Node (#699). Null: it was running.
 */
export function hostStartNote(m: Pick<MachineInfo, 'hostStarted' | 'status'>): string | null {
  const s = m.hostStarted
  if (!s) return null
  if (s.how === 'detached') return `This computer started Centralu there. It keeps running when this computer disconnects.${s.note ? ` ${s.note}` : ''}`
  return `Centralu runs there only while this computer is linked, and stops with the link.${s.note ? ` ${s.note}` : ''}`
}

/**
 * Windows gives an Administrators account over ssh a full token with no UAC split, so every agent runs elevated (#702).
 * Not a refusal: the person may want it.
 */
export function elevatedNote(m: Pick<MachineInfo, 'elevated' | 'name' | 'shell'>): { title: string; fix: string } | null {
  if (m.elevated !== true) return null
  const windows = m.shell === 'powershell' || m.shell === 'wsl'
  return {
    title: `Agents on ${m.name} run with administrator rights: ${windows ? 'Windows gives an administrator who signs in over ssh a full, elevated token' : 'its host runs as root'}.`,
    fix: `To run them as an ordinary user, link ${m.name} through a standard account with its own ssh key.`,
  }
}

/**
 * Windows OpenSSH's key login is a network logon with no password: the Credential Manager vault stays locked, so Git
 * cannot use (or save) a sign-in saved in Windows (#1224). The sign-in task moves the host into the person's sign-in.
 */
export function logonNote(m: Pick<MachineInfo, 'logon' | 'name'> & Partial<Pick<MachineInfo, 'handover'>>): { title: string; fix: string } | null {
  if (m.logon !== 'network') return null
  const title = `Centralu runs on ${m.name} without your Windows sign-in, so Git there cannot use the credentials saved in Windows.`
  const ssh = 'A repository with an SSH remote works either way.'
  // The sign-in's serve waits for the host's work to end, for 30 minutes at most (#1224)
  if (m.handover?.state === 'waiting') return { title, fix: `It moves into your sign-in on ${m.name} once its agents, terminals and commands there are idle. ${ssh}` }
  if (m.handover?.state === 'gave_up') {
    return { title, fix: `It could not move into your sign-in on ${m.name}: its agents, terminals or commands stayed busy for 30 minutes. It tries again at your next sign-in there. ${ssh}` }
  }
  return { title, fix: `Sign in on ${m.name}: Centralu moves into your sign-in once its agents are idle. ${ssh}` }
}

/** docs/plans/remote-hub.md §4: across protocols nothing connects; on one protocol "connect anyway" is offered */
export type VersionPrompt = {
  compatible: boolean
  /** Set when held only because the remote is below `MIN_SUPPORTED_VERSION` on one protocol (#1143) */
  minimum: string | null
  /** Known only on one channel with no dev build */
  older: 'hub' | 'remote' | null
  target: string | null
  /** For when this computer cannot update an older remote itself */
  remoteCommand: string | null
  /** The remote is older, this computer runs a published release, and the machine runs no command of the person's */
  updateHere: boolean
  text: string
  /** `centralu.cmd` on PowerShell (#688) */
  centralu: string
  /** False when connected and the update only offered: one protocol connects whatever the app versions (#689) */
  held: boolean
}

export function versionPrompt(m: Pick<MachineInfo, 'name' | 'status' | 'versions'> & Partial<Pick<MachineInfo, 'command' | 'shell'>>): VersionPrompt | null {
  const v = m.versions
  if (!v) return null
  const held = m.status === 'versions_differ'
  if (!held && !(m.status === 'connected' && v.compatible && v.older)) return null
  const hub = v.hub.version
  // A local build installs the release it was cut from (#689)
  const hubRelease = releaseOf(hub)
  const remote = v.remote.version
  const target = v.older === 'hub' ? remote : v.older === 'remote' ? hubRelease : null
  const remoteCommand = v.older === 'remote' ? `${shims(m).npm} i -g centralu@${hubRelease}` : null
  const updateHere = v.older === 'remote' && !v.hub.dev && !m.command
  const or = held ? 'connect anyway' : 'keep it as it is'
  const minimum = !v.compatible && v.hub.protocolVersion === v.remote.protocolVersion ? MIN_SUPPORTED_VERSION : null
  let text: string
  if (minimum) {
    text = `${m.name} runs Centralu ${remote}, older than ${minimum}, the oldest this computer works with. They cannot connect until ${m.name} is updated.`
  } else if (!v.compatible) {
    const side = v.older === 'hub' ? 'this computer' : v.older === 'remote' ? m.name : 'one side'
    text = `${m.name} runs Centralu ${remote} (protocol ${v.remote.protocolVersion}) and this computer runs ${hub} (protocol ${v.hub.protocolVersion}). They cannot talk to each other until ${side} is updated.`
  } else if (v.older === 'hub') {
    text = `${m.name} runs Centralu ${remote}, newer than this computer's ${hub}. Update this computer, or ${or}.`
  } else if (v.older === 'remote') {
    text = `${m.name} runs Centralu ${remote}, older than this computer's ${hub}${hubRelease === hub ? '' : ` (a local build; ${hubRelease} is what gets installed there)`}. Update it${updateHere ? '' : ' there'}, or ${or}.`
  } else {
    text = `${m.name} runs Centralu ${remote} and this computer runs ${hub}${v.sameChannel ? '' : ', from another release channel'}. Align them, or ${or}.`
  }
  return { compatible: v.compatible, minimum, older: v.older, target, remoteCommand, updateHere, text, held, centralu: shims(m).centralu }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** With no keeper on the remote, its agents end with its host (docs/plans/remote-hub.md §10.5) */
export function updateStops(name: string, activity: HostActivity | null | undefined): string {
  const after = 'Sessions resume on the new version; a turn in progress is lost.'
  if (!activity) {
    return `Updating stops Centralu on ${name} while it switches: any agent working there stops, and so do its terminals and running commands. ${after}`
  }
  const parts = [
    activity.working ? count(activity.working, 'working session', 'working sessions') : null,
    activity.approvals ? count(activity.approvals, 'session waiting on an approval', 'sessions waiting on an approval') : null,
    activity.questions ? count(activity.questions, 'session asking a question', 'sessions asking a question') : null,
    activity.background ? count(activity.background, 'session running background work', 'sessions running background work') : null,
    activity.terminals ? count(activity.terminals, 'terminal', 'terminals') : null,
    activity.commandRuns ? count(activity.commandRuns, 'running command', 'running commands') : null,
  ].filter((x): x is string => x !== null)
  if (parts.length === 0) return `Nothing is running on ${name}. Updating stops Centralu there and starts the new version.`
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `Updating stops Centralu on ${name} while it switches, and with it ${list}. ${after}`
}

/** Null without `hubWaits`: a hub without `MachineInfo.updateWaits` stops at once and ignores `when` (#1399) */
export function updateWaits(name: string, activity: HostActivity | null | undefined, hubWaits: boolean | undefined): string | null {
  const n = turnsRunning(activity)
  if (!activity || n === 0 || hubWaits !== true) return null
  const them = n === 1 ? 'it is' : 'they are'
  return `${count(n, 'session', 'sessions')} on ${name} ${n === 1 ? 'is' : 'are'} in a turn. Update installs beside Centralu there and waits until ${them} done; nothing is stopped before that. Then it stops Centralu there while it switches: its terminals and running commands end with it, and sessions resume on the new version.`
}

const STEP_TEXT: Record<string, string> = {
  preflight: 'checking the machine',
  registry: 'checking the packages',
  node: 'installing Node',
  centralu: 'installing Centralu',
  wait_idle: 'waiting for its sessions to finish',
  wait_open: 'waiting for its open terminals and commands',
  wait_unread: 'waiting: it cannot read what runs there now',
  stop: 'stopping Centralu there',
  switch: 'switching versions',
  start: 'starting Centralu there',
  check: 'waiting for it to answer',
  prune: 'removing old versions',
  roll_back: 'did not answer; putting the old version back',
  autostart: 'removing its start at boot',
  remove: 'removing it',
}

const AUTOSTART_TEXT: Record<string, string> = {
  on: 'Turning on its start at boot…',
  off: 'Turning off its start at boot…',
  status: 'Asking whether it starts at boot…',
}

export function operationNote(m: Pick<MachineInfo, 'operation'>): string | null {
  const o = m.operation
  if (!o) return null
  if (o.kind === 'autostart') return AUTOSTART_TEXT[o.step] ?? `Changing its start at boot: ${o.step}…`
  const what =
    o.kind === 'install'
      ? `Installing Centralu${o.target ? ` ${o.target}` : ''}`
      : o.kind === 'update'
        ? `Updating to ${o.target ?? 'this computer’s version'}`
        : o.kind === 'rollback'
          ? `Rolling back to ${o.target ?? 'the earlier version'}`
          : 'Removing Centralu'
  // A host that sent no count gets the plain step text (#1579)
  if (o.step === 'wait_idle' && o.count !== undefined) return `${what}: waiting for ${count(o.count, 'session', 'sessions')} in a turn…`
  if (o.step === 'wait_open' && o.count !== undefined) return `${what}: waiting for ${o.count === 1 ? '1 open terminal or command there (Cancel, then Update, closes it)' : `${o.count} open terminals or commands there (Cancel, then Update, closes them)`}…`
  return `${what}: ${STEP_TEXT[o.step] ?? o.step}…`
}

/** Automatic updates cover the linked machines too (#1508) */
export function followHubLead(autoApply: boolean): string | null {
  return autoApply
    ? "While automatic updates are on, linked machines follow this computer's version: each one on an older release is updated once no session there is in a turn."
    : null
}

export function followHubNote(m: Pick<MachineInfo, 'followHub'>): string | null {
  const f = m.followHub
  if (!f) return null
  const next = f.retryAt !== null ? 'This computer tries once more in a few minutes.' : 'This computer does not try again for this version; Update it here.'
  return `Updating it to ${f.version} by itself did not go through: ${f.failed.replace(/[.\s]+$/, '')}. ${next}`
}

/** PowerShell resolves the bare names to the `.ps1` shims a default execution policy blocks (#688) */
function shims(m: Partial<Pick<MachineInfo, 'shell'>>): { npm: string; centralu: string } {
  return m.shell === 'powershell' ? { npm: 'npm.cmd', centralu: 'centralu.cmd' } : { npm: 'npm', centralu: 'centralu' }
}

export function installNote(m: Pick<MachineInfo, 'install'>): string | null {
  const i = m.install
  if (!i?.current) return null
  // `pnpm remote-dev` (#1036)
  const dev = i.current.source?.kind === 'dev' ? `, a dev build of ${i.current.source.commit.slice(0, 10)}${i.current.source.dirty ? ' with uncommitted changes' : ''}` : ''
  return `Installed from this computer: Centralu ${i.current.version}${dev}${i.previous ? ` (${i.previous.version} kept to roll back to)` : ''}`
}

export type AutostartRow = { label: string; on: boolean; note: string | null }

/** The reverse direction's switch (#550, docs/plans/remote-hub.md §12.7) */
export function asksRow(m: Pick<MachineInfo, 'asks' | 'name'>): { label: string; on: boolean; confirm: string; note: string | null } | null {
  if (!m.asks) return null
  return {
    label: `Let sessions on ${m.name} ask this computer's projects`,
    on: m.asks.on,
    confirm:
      `Sessions on ${m.name} may then ask this computer's projects to do work, with ask_project, and nothing else here. ` +
      `The first time a session there asks a project here, a card asks you on this computer; once you allow that pair, ` +
      `its later asks need no card until you withdraw it below. Turning this off forgets every pair.`,
    note: m.asks.on ? m.asks.note : null,
  }
}

/**
 * docs/plans/remote-hub.md §10.4 (per machine, off by default). Null on macOS, a Linux without systemd, WSL without
 * interop, or a machine that never said.
 */
export function autostartRow(m: Pick<MachineInfo, 'autostart' | 'name'>): AutostartRow | null {
  const a = m.autostart
  if (!a?.how) return null
  if (a.how === 'systemd') {
    return {
      label: `Start Centralu when ${m.name} starts`,
      on: a.on,
      note:
        a.on && a.linger === false
          ? `Until an administrator there runs \`sudo loginctl enable-linger $USER\` for your account, it starts when you log in to ${m.name}, not at boot.`
          : null,
    }
  }
  return {
    label: `Start Centralu when you sign in to ${m.name}`,
    on: a.on,
    note: a.on ? 'Windows starts it at sign-in; with automatic sign-in, that is at boot.' : null,
  }
}
