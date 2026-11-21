import type { MachineProbe, RemoteShell, SshHost } from '@cc/protocol/client'
import { machineProblem, type MachineProblem } from './machines.js'

/**
 * The Add machine dialog's choices (#514): a probed ssh host offers ready rows ("Windows", "WSL (Ubuntu)", "Linux or
 * macOS") in place of a shell to choose and a distro to type.
 */

/** What `ssh -G` resolved, as `me@box.lan:2222` (port 22 left out) */
export function sshHostDetail(h: Pick<SshHost, 'alias' | 'hostName' | 'user' | 'port'>): string | null {
  if (!h.hostName && !h.user) return null
  const host = h.hostName ?? h.alias
  return `${h.user ? `${h.user}@` : ''}${host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`
}

export type MachineChoice = {
  key: string
  label: string
  detail: string | null
  shell: RemoteShell
  wslDistro: string | null
  name: string
  /** The machine already linked this way: the row is not offered again */
  linkedAs: string | null
}

const WINDOWS_SHELL: Record<NonNullable<MachineProbe['windowsShell']>, string> = {
  cmd: 'cmd.exe answers ssh',
  powershell: 'PowerShell answers ssh',
  pwsh: 'PowerShell 7 answers ssh',
  other: 'Its own default shell answers ssh',
}

/** None when the probe told nothing: the person chooses by hand */
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

export function firstChoice(choices: readonly MachineChoice[]): MachineChoice | null {
  return choices.find((c) => !c.linkedAs) ?? null
}

export function probeProblem(probe: MachineProbe): MachineProblem | null {
  if (!probe.reachable) {
    const p = machineProblem({ status: 'unreachable', error: probe.error, name: probe.sshTarget, sshTarget: probe.sshTarget }) ?? { title: `${probe.sshTarget} is away`, fix: null }
    // Nothing retries here until the person picks the host again
    const fix = p.fix?.replace(/reconnect$/, 'pick it again').replace(/\.? ?Centralu keeps trying$/, '') || null
    return { title: p.title, fix }
  }
  if (probe.os) return null
  return { title: `Could not tell what runs on ${probe.sshTarget}${probe.error ? `: ${probe.error}` : ''}`, fix: 'Enter it by hand, and choose what it runs' }
}
