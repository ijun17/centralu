import { releaseOf, turnsRunning, type HostActivity, type MachineInfo, type MachineStatus } from '@cc/protocol'

/**
 * Linked machines on the screen (#82, docs/plans/remote-hub.md): which rows are away, what a link's
 * state and last error mean in words a person can act on, and what the version prompt offers. Pure,
 * so the rules are tested without a host or React.
 */

/** What the UI knows about one session or project's machine */
type Placed = { machine?: string | null; unreachable?: boolean }

/**
 * Whether a session or project on a linked machine is away: the hub listed it from its mirror
 * (`unreachable`), or the machine's link is not up now. Away rows stay listed and dimmed, and are
 * never woken: waking one would only fail at the hub, and the machine's `machine_resync` wakes what
 * has to be woken once it is back. This computer's rows are never away.
 *
 * A machine the UI has no row for yet (its list has not arrived) is judged by the row's own mark.
 */
export function isAway(row: Placed | undefined, machines: Readonly<Record<string, MachineInfo>>): boolean {
  if (!row?.machine) return false
  if (row.unreachable) return true
  const m = machines[row.machine]
  return !!m && m.status !== 'connected'
}

/** One word or two for a link's state, as Add project's machine menu and Settings say it */
export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  connected: 'connected',
  connecting: 'connecting',
  unreachable: 'away',
  not_running: 'not running',
  versions_differ: 'version mismatch',
  refused: 'refused',
  starting: 'starting',
  updating: 'updating',
  disconnected: 'disconnected',
  stopped: 'stopped',
}

export type MachineProblem = {
  /** What is wrong, in one sentence */
  title: string
  /** What the person can do about it, when there is something; a command is quoted with backticks */
  fix: string | null
}

/**
 * The link's last error, turned into what to do (#82). The host's `error` keeps ssh's own last line
 * (`links/tunnel.ts`); these are the failures a person meets when linking a machine for the first
 * time, each with the one step that fixes it. Anything not recognised is shown as the host said it.
 */
export function machineProblem(m: Pick<MachineInfo, 'status' | 'error' | 'name' | 'sshTarget'> & Partial<Pick<MachineInfo, 'shell' | 'autoReconnect'>>): MachineProblem | null {
  // Disconnected on purpose (#1134): nothing is wrong, and the row says how it connects again
  if (m.status === 'connected' || m.status === 'disconnected') return null
  const e = m.error ?? ''
  if ((m.status === 'connecting' || m.status === 'starting') && !e) return null
  if (m.status === 'versions_differ') return { title: e || `${m.name} runs another version of Centralu`, fix: null }
  // Stopped there, by the person or after its hosts kept stopping (#1143): the host says which, and Start starts one
  if (m.status === 'stopped') return { title: e || `Centralu is stopped on ${m.name}`, fix: 'Press Start to start it there' }
  if (m.status === 'not_running') {
    // This computer tried to start it and says why; an older hub only said it was not serving
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

/** What an away machine's row says comes next (#1341): the host keeps trying only while Auto reconnect is on */
function tries(m: Partial<Pick<MachineInfo, 'autoReconnect'>>): string {
  return m.autoReconnect === false ? 'Auto reconnect is off: press Connect to try again' : 'Centralu keeps trying'
}

/**
 * What the machine's row says about a host this computer started there (plan §10.9, decision 7):
 * started in the background, or, where Windows blocks starting it that way, only while linked.
 * `note` adds what the hub did on the way: why it is linked only while linked, or that it installed its
 * own Node there because the machine's was too old (#699).
 * Null when the host was already running.
 */
export function hostStartNote(m: Pick<MachineInfo, 'hostStarted' | 'status'>): string | null {
  const s = m.hostStarted
  if (!s) return null
  if (s.how === 'detached') return `This computer started Centralu there. It keeps running when this computer disconnects.${s.note ? ` ${s.note}` : ''}`
  return `Centralu runs there only while this computer is linked, and stops with the link.${s.note ? ` ${s.note}` : ''}`
}

/**
 * The one sentence a machine's row says when its host runs with administrator rights (#702): on Windows an account in
 * the Administrators group linked over ssh gets a full token, with no UAC split, so every agent there runs as an
 * administrator. Not a refusal: the person may want it. The way out is a standard account with its own ssh key. Null
 * when the host did not say so.
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
 * The one sentence a machine's row says when its host runs in a network logon (#1224): the logon Windows OpenSSH gives
 * a key login carries no password, so the user's Credential Manager vault stays locked there and Git cannot use a
 * sign-in saved in Windows (nor save one). The way out is the person's own sign-in on that computer, where Centralu
 * starts its host when someone is signed in (`centralu serve --detach`, through the sign-in task). An SSH remote needs
 * no saved sign-in. Null when the host did not say so.
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

/**
 * What the version prompt offers for a link held at `versions_differ` (plan §4): bring the older
 * side up to the newer one, or connect anyway when the protocols match. Across protocols nothing
 * connects, and the prompt says which side to update.
 */
export type VersionPrompt = {
  /** The two sides speak one protocol: "connect anyway" is possible */
  compatible: boolean
  /** Which side to update, when that is known (one channel, no dev build) */
  older: 'hub' | 'remote' | null
  /** The version to bring the older side to */
  target: string | null
  /** For an older remote, the exact command to run there, for when this computer cannot update it */
  remoteCommand: string | null
  /**
   * This computer can update the remote itself (`machines.update`, plan §10.5): the remote is older,
   * this computer runs a published release, and the machine runs no command of the person's own
   */
  updateHere: boolean
  /** One sentence for the person */
  text: string
  /** The command to restart the remote's host with, in its shell's terms: `centralu`, or `centralu.cmd` on PowerShell (#688) */
  centralu: string
  /**
   * The link waits for the person (`versions_differ`: another protocol). False when it is connected
   * and the update is only offered: one protocol connects whatever the app versions (#689)
   */
  held: boolean
}

export function versionPrompt(m: Pick<MachineInfo, 'name' | 'status' | 'versions'> & Partial<Pick<MachineInfo, 'command' | 'shell'>>): VersionPrompt | null {
  const v = m.versions
  if (!v) return null
  const held = m.status === 'versions_differ'
  // Connected on one protocol with an older side: the update is offered, not required
  if (!held && !(m.status === 'connected' && v.compatible && v.older)) return null
  const hub = v.hub.version
  // A local build installs the release it was cut from (#689), so that is what the other side is brought to
  const hubRelease = releaseOf(hub)
  const remote = v.remote.version
  const target = v.older === 'hub' ? remote : v.older === 'remote' ? hubRelease : null
  const remoteCommand = v.older === 'remote' ? `${shims(m).npm} i -g centralu@${hubRelease}` : null
  const updateHere = v.older === 'remote' && !v.hub.dev && !m.command
  const or = held ? 'connect anyway' : 'keep it as it is'
  let text: string
  if (!v.compatible) {
    const side = v.older === 'hub' ? 'this computer' : v.older === 'remote' ? m.name : 'one side'
    text = `${m.name} runs Centralu ${remote} (protocol ${v.remote.protocolVersion}) and this computer runs ${hub} (protocol ${v.hub.protocolVersion}). They cannot talk to each other until ${side} is updated.`
  } else if (v.older === 'hub') {
    text = `${m.name} runs Centralu ${remote}, newer than this computer's ${hub}. Update this computer, or ${or}.`
  } else if (v.older === 'remote') {
    text = `${m.name} runs Centralu ${remote}, older than this computer's ${hub}${hubRelease === hub ? '' : ` (a local build; ${hubRelease} is what gets installed there)`}. Update it${updateHere ? '' : ' there'}, or ${or}.`
  } else {
    text = `${m.name} runs Centralu ${remote} and this computer runs ${hub}${v.sameChannel ? '' : ', from another release channel'}. Align them, or ${or}.`
  }
  return { compatible: v.compatible, older: v.older, target, remoteCommand, updateHere, text, held, centralu: shims(m).centralu }
}

/** Plural for counts in a sentence: "1 terminal", "2 terminals" */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What the "Update <machine>" prompt says will stop (plan §10.5): the remote's host stops while it
 * switches, and with no keeper there (Linux and Windows remotes today) its agents end with it. Their
 * sessions resume on the new version through their stored ids; a turn in progress is lost. `activity`
 * is the remote's own count (`machines.activity`); unknown is said as "anything running"
 */
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

/**
 * What the "Update <machine>" prompt says when sessions there are in a turn (#1399): the update installs beside and waits for them,
 * and stops nothing before they are done. Null when none is, or the machine cannot say (then `updateStops` words it), or the hub
 * does not wait (`MachineInfo.updateWaits` absent: a hub from before #1399 stops at once and ignores `when`, so the window must not
 * promise a wait there)
 */
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

/** The row's line while the hub installs, updates, rolls back or removes Centralu there, or changes its start at boot; null otherwise */
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
  return `${what}: ${STEP_TEXT[o.step] ?? o.step}…`
}

/**
 * What to tell a person to type on the machine: a Windows PowerShell gets the `.cmd` shims, as the bare
 * names resolve to the `.ps1` ones a default execution policy blocks (#688)
 */
function shims(m: Partial<Pick<MachineInfo, 'shell'>>): { npm: string; centralu: string } {
  return m.shell === 'powershell' ? { npm: 'npm.cmd', centralu: 'centralu.cmd' } : { npm: 'npm', centralu: 'centralu' }
}

/** What the row says about the Centralu this computer installed there; null when it installed none */
export function installNote(m: Pick<MachineInfo, 'install'>): string | null {
  const i = m.install
  if (!i?.current) return null
  // A dev build made there from a commit (`pnpm remote-dev`, #1036) is never mistaken for a release
  const dev = i.current.source?.kind === 'dev' ? `, a dev build of ${i.current.source.commit.slice(0, 10)}${i.current.source.dirty ? ' with uncommitted changes' : ''}` : ''
  return `Installed from this computer: Centralu ${i.current.version}${dev}${i.previous ? ` (${i.previous.version} kept to roll back to)` : ''}`
}

/** The row's start-at-boot switch: what it says, whether it is on, and what it does not do there yet */
export type AutostartRow = { label: string; on: boolean; note: string | null }

/**
 * The reverse direction's switch (#550, docs/plans/remote-hub.md §12.7, owner decision 2026-10-18): its label, the
 * question turning it on asks once (what it allows, and what it does not), and the row's note when it is on but cannot
 * work. Null from a hub that predates it
 */
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
 * The start-at-boot switch of a machine's row (docs/plans/remote-hub.md §10.4, owner decision 4: per machine, off by
 * default), from what the machine said it would use. Null where it offers nothing (macOS, a Linux without systemd, WSL
 * without interop) or has not said (a machine that predates it, or never answered).
 *
 * The note says where the switch falls short of "at boot": a systemd user manager that starts only at login because
 * enabling lingering there needs an administrator, and a Windows task, which runs at sign-in.
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
