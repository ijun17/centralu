import { wireSegments, type MachineInfo } from '@cc/protocol/client'

/**
 * A linked machine's path opened in VS Code over Remote-SSH (#82, docs/plans/remote-hub.md §6). VS Code's handler
 * (`getWindowOpenableFromProtocolUrl`) takes the path up to its second slash as the authority and opens a path ending
 * in `:<digits>` as a file at that line, anything else as a folder; it decodes percent-encoded segments.
 */

export type RemoteIdeTarget = { ok: true; url: string } | { ok: false; reason: string }

/** A slash would end the link's authority (an `ssh://` URL, say) */
const LINKABLE_TARGET = /^[^\s/\\?#]+$/

/** The only kind of Windows root a link can name */
const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]?(.*)$/

/** Asked before a button is drawn, so a person never presses one that cannot work */
export function remoteIdeSupport(machine: Pick<MachineInfo, 'name' | 'sshTarget' | 'shell'>): { ok: true } | { ok: false; reason: string } {
  if (machine.shell === 'wsl') {
    // Remote-SSH opens a Windows session there; `\\wsl.localhost\` from an sshd session is not measured working
    return { ok: false, reason: `VS Code's Remote-SSH reaches Windows on ${machine.name}, not the WSL distro the project is in` }
  }
  if (!LINKABLE_TARGET.test(machine.sshTarget) || machine.sshTarget.startsWith('-')) {
    return { ok: false, reason: `VS Code's Remote-SSH needs a host name or a ~/.ssh/config alias, not ${machine.sshTarget}` }
  }
  return { ok: true }
}

/** `rel` is project-relative and `/`-separated (`''` for the project); `file` absent opens a folder */
export function remoteIdeUrl(
  machine: Pick<MachineInfo, 'name' | 'sshTarget' | 'shell'>,
  root: string,
  rel: string,
  file?: { line?: number | null },
): RemoteIdeTarget {
  const support = remoteIdeSupport(machine)
  if (!support.ok) return support

  let segments: string[]
  let drive: string | null = null
  if (machine.shell === 'powershell') {
    const [, letter, rest] = WINDOWS_DRIVE.exec(root) ?? []
    if (letter === undefined || rest === undefined) return { ok: false, reason: `VS Code's Remote-SSH opens a folder on a drive; ${root} is not one` }
    drive = `${letter.toUpperCase()}:`
    segments = rest.split(/[\\/]/)
  } else {
    if (!root.startsWith('/')) return { ok: false, reason: `${root} is not an absolute path on ${machine.name}` }
    segments = wireSegments(root)
  }
  segments.push(...wireSegments(rel))
  const parts = segments.filter((s) => s !== '' && s !== '.')
  // A path from the host never climbs out; one that does is not handed to an editor
  if (parts.includes('..')) return { ok: false, reason: `${rel} leaves the project` }

  // VS Code names a remote drive path `/C:/Users/...`, the colon kept
  const path = (drive ? `/${drive}` : '') + parts.map((s) => `/${encodeURIComponent(s)}`).join('') || '/'
  const line = file ? `:${Math.max(1, Math.trunc(file.line ?? 1))}` : ''
  // `@` is legal here and reads better than `%40`
  const target = encodeURIComponent(machine.sshTarget).replaceAll('%40', '@')
  return { ok: true, url: `vscode://vscode-remote/ssh-remote+${target}${path}${line}` }
}
