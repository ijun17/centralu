import type { MachineProbe, RemoteShell, SshHost } from '@cc/protocol'
import { machineProblem, type MachineProblem } from './machines.js'

/**
 * The Add machine dialog's choices (#514): the hosts of the person's ssh config, and, once one is
 * picked and probed, the ready rows it offers ("Windows", "WSL (Ubuntu)", "Linux or macOS") in place
 * of a shell to choose and a distro to type. Pure, so the rules are tested without a host or React.
 */

/** What `ssh -G` resolved for an alias, as one short line: `me@box.lan:2222` (port 22 left out) */
export function sshHostDetail(h: Pick<SshHost, 'alias' | 'hostName' | 'user' | 'port'>): string | null {
  if (!h.hostName && !h.user) return null
  const host = h.hostName ?? h.alias
  return `${h.user ? `${h.user}@` : ''}${host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`
}

/** One way to link a probed host: the shell and distro `machines.add` takes, and the name it suggests */
export type MachineChoice = {
  key: string
  label: string
  /** A second line: which shell answers ssh there, the default distro */
  detail: string | null
  shell: RemoteShell
  wslDistro: string | null
  /** The machine name it suggests; the person can change it */
  name: string
  /** The name of the machine already linked this way, when there is one: the row is not offered again */
  linkedAs: string | null
}

const WINDOWS_SHELL: Record<NonNullable<MachineProbe['windowsShell']>, string> = {
  cmd: 'cmd.exe answers ssh',
  powershell: 'PowerShell answers ssh',
  pwsh: 'PowerShell 7 answers ssh',
  other: 'Its own default shell answers ssh',
}

/**
 * The rows a probe offers for an alias, in the order shown: Windows, then each WSL distro (the default
 * first, as the probe lists them); or the one POSIX row. None when nothing was told (the person
 * chooses by hand). A row already linked through this alias is marked with that machine's name
 */
export function probeChoices(alias: string, probe: MachineProbe, linked: SshHost['linked']): MachineChoice[] {
  const linkedAs = (shell: RemoteShell, distro: string | null) =>
    linked.find((l) => l.shell === shell && (shell !== 'wsl' || (l.wslDistro ?? '').toLowerCase() === (distro ?? '').toLowerCase()))?.name ?? null
  if (probe.os === 'posix') {
    return [{ key: 'posix', label: 'Linux or macOS', detail: null, shell: 'posix', wslDistro: null, name: alias, linkedAs: linkedAs('posix', null) }]
  }
  if (probe.os !== 'windows') return []
  return [
    {
      key: 'windows',
      label: 'Windows',
      detail: probe.windowsShell ? WINDOWS_SHELL[probe.windowsShell] : null,
      shell: 'powershell',
      wslDistro: null,
      name: alias,
      linkedAs: linkedAs('powershell', null),
    },
    ...probe.wslDistros.map((d) => ({
      key: `wsl:${d.name}`,
      label: `WSL (${d.name})`,
      detail: d.default ? 'The default distro' : null,
      shell: 'wsl' as const,
      wslDistro: d.name,
      name: `${alias} ${d.name}`,
      linkedAs: linkedAs('wsl', d.name),
    })),
  ]
}

/** The row picked for the person when a probe answers: the first one not linked yet */
export function firstChoice(choices: readonly MachineChoice[]): MachineChoice | null {
  return choices.find((c) => !c.linkedAs) ?? null
}

/**
 * What to say when a probe told nothing, in one sentence and a step (the link's own words for ssh's
 * failures, `machineProblem`); null when it told what runs there
 */
export function probeProblem(probe: MachineProbe): MachineProblem | null {
  if (!probe.reachable) {
    const p = machineProblem({ status: 'unreachable', error: probe.error, name: probe.sshTarget, sshTarget: probe.sshTarget })!
    // Said of a link that retries on its own; here nothing retries until the person picks the host again
    const fix = p.fix?.replace(/reconnect$/, 'pick it again').replace(/\.? ?Centralu keeps trying$/, '') || null
    return { title: p.title, fix }
  }
  if (probe.os) return null
  return { title: `Could not tell what runs on ${probe.sshTarget}${probe.error ? `: ${probe.error}` : ''}`, fix: 'Enter it by hand, and choose what it runs' }
}
