import type { MachineInfo, MachineStatus } from '@cc/protocol'

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

/** One word or two for a link's state, as the sidebar's machine header and Settings say it */
export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  connected: 'connected',
  connecting: 'connecting',
  unreachable: 'away',
  not_running: 'not running',
  versions_differ: 'version mismatch',
  refused: 'refused',
  starting: 'starting',
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
export function machineProblem(m: Pick<MachineInfo, 'status' | 'error' | 'name' | 'sshTarget'>): MachineProblem | null {
  if (m.status === 'connected') return null
  const e = m.error ?? ''
  if ((m.status === 'connecting' || m.status === 'starting') && !e) return null
  if (m.status === 'versions_differ') return { title: e || `${m.name} runs another version of Centralu`, fix: null }
  if (m.status === 'not_running') {
    // This computer tried to start it and says why; an older hub only said it was not serving
    return {
      title: e || `Centralu is installed on ${m.name}, but it is not serving`,
      fix: `Run \`centralu serve --detach\` on ${m.name} (it keeps running after you log out), then reconnect`,
    }
  }
  if (/not installed on/i.test(e)) {
    return { title: `Centralu is not installed on ${m.name}`, fix: `Install it there with \`npm i -g centralu\`, then run \`centralu serve\` once` }
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
    return { title: `${m.name} does not answer`, fix: 'It may be asleep, off or on another network. Centralu keeps trying' }
  }
  if (m.status === 'refused') return { title: e || `${m.name} refused the link`, fix: 'Restart `centralu serve` there, then reconnect' }
  return e ? { title: e, fix: null } : { title: `${m.name} is away`, fix: 'Centralu keeps trying' }
}

/**
 * What the machine's row says about a host this computer started there (plan §10.9, decision 7):
 * started in the background, or, where Windows blocks starting it that way, only while linked.
 * Null when the host was already running.
 */
export function hostStartNote(m: Pick<MachineInfo, 'hostStarted' | 'status'>): string | null {
  const s = m.hostStarted
  if (!s) return null
  if (s.how === 'detached') return 'This computer started Centralu there. It keeps running when this computer disconnects.'
  return `Centralu runs there only while this computer is linked, and stops with the link.${s.note ? ` ${s.note}` : ''}`
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
  /** For an older remote, the exact command to run there (phase 1 has no update over ssh) */
  remoteCommand: string | null
  /** One sentence for the person */
  text: string
}

export function versionPrompt(m: Pick<MachineInfo, 'name' | 'status' | 'versions'>): VersionPrompt | null {
  const v = m.versions
  if (!v || m.status !== 'versions_differ') return null
  const hub = v.hub.version
  const remote = v.remote.version
  const target = v.older === 'hub' ? remote : v.older === 'remote' ? hub : null
  const remoteCommand = v.older === 'remote' ? `npm i -g centralu@${hub}` : null
  let text: string
  if (!v.compatible) {
    const side = v.older === 'hub' ? 'this computer' : v.older === 'remote' ? m.name : 'one side'
    text = `${m.name} runs Centralu ${remote} (protocol ${v.remote.protocolVersion}) and this computer runs ${hub} (protocol ${v.hub.protocolVersion}). They cannot talk to each other until ${side} is updated.`
  } else if (v.older === 'hub') {
    text = `${m.name} runs Centralu ${remote}, newer than this computer's ${hub}. Update this computer, or connect anyway.`
  } else if (v.older === 'remote') {
    text = `${m.name} runs Centralu ${remote}, older than this computer's ${hub}. Update it there, or connect anyway.`
  } else {
    text = `${m.name} runs Centralu ${remote} and this computer runs ${hub}${v.sameChannel ? '' : ', from another release channel'}. Align them, or connect anyway.`
  }
  return { compatible: v.compatible, older: v.older, target, remoteCommand, text }
}
