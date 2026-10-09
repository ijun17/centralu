import type { MachineInfo } from '@cc/protocol'

/**
 * Opening a linked machine's file or folder in VS Code over Remote-SSH (#82, docs/plans/remote-hub.md §6).
 *
 * An IDE on this computer cannot open another machine's path, and the hub has no copy of its files. What it can do is
 * hand VS Code a `vscode://vscode-remote/ssh-remote+<target><path>` link: VS Code opens a window that connects to the
 * same ssh target the link uses and opens the path there. The path is the machine's own: the project's root as its
 * host reported it (`ProjectInfo.path`) joined with the project-relative path the routed file tree and diff use.
 *
 * VS Code's handler (`getWindowOpenableFromProtocolUrl`, src/vs/code/electron-main/app.ts) decodes the link's path,
 * takes everything up to its second slash as the remote authority, opens a path that ends in `:<digits>` as a file at
 * that line and anything else as a folder. So a file always carries a line (1 when none is known), and every
 * segment is percent-encoded, which VS Code decodes back.
 */

export type RemoteIdeTarget = { ok: true; url: string } | { ok: false; reason: string }

/** `[user@]host` or a `~/.ssh/config` alias. A slash would end the link's authority (an `ssh://` URL, say) */
const LINKABLE_TARGET = /^[^\s/\\?#]+$/

/** `C:\Users\me` or `C:/Users/me`: a drive path, the only kind of Windows root a link can name */
const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]?(.*)$/

/**
 * Whether a machine's projects can be opened this way at all, and why not when they cannot. Asked once per machine,
 * before a button is drawn, so a person never presses one that cannot work.
 */
export function remoteIdeSupport(machine: Pick<MachineInfo, 'name' | 'sshTarget' | 'shell'>): { ok: true } | { ok: false; reason: string } {
  if (machine.shell === 'wsl') {
    /*
     * The ssh target is the Windows side; the project lives in a distro behind it. Remote-SSH would open a Windows
     * session there, where the distro's Linux path does not exist, and reaching it through `\\wsl.localhost\` from an
     * sshd session is not something we have measured working.
     */
    return { ok: false, reason: `VS Code's Remote-SSH reaches Windows on ${machine.name}, not the WSL distro the project is in` }
  }
  if (!LINKABLE_TARGET.test(machine.sshTarget) || machine.sshTarget.startsWith('-')) {
    return { ok: false, reason: `VS Code's Remote-SSH needs a host name or a ~/.ssh/config alias, not ${machine.sshTarget}` }
  }
  return { ok: true }
}

/**
 * The link that opens `rel` (project-relative, `/`-separated, `''` for the project itself) of a project rooted at
 * `root` on `machine`. `line` is given for a file and absent for a folder.
 */
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
    const m = WINDOWS_DRIVE.exec(root)
    if (!m) return { ok: false, reason: `VS Code's Remote-SSH opens a folder on a drive; ${root} is not one` }
    drive = `${m[1]!.toUpperCase()}:`
    segments = m[2]!.split(/[\\/]/)
  } else {
    if (!root.startsWith('/')) return { ok: false, reason: `${root} is not an absolute path on ${machine.name}` }
    segments = root.split('/')
  }
  segments.push(...rel.split('/'))
  const parts = segments.filter((s) => s !== '' && s !== '.')
  // A project-relative path from the host never climbs out; one that does is not something to hand to an editor
  if (parts.includes('..')) return { ok: false, reason: `${rel} leaves the project` }

  // Windows: VS Code names a remote drive path `/C:/Users/...`, the drive's colon kept as it is
  const path = (drive ? `/${drive}` : '') + parts.map((s) => `/${encodeURIComponent(s)}`).join('') || '/'
  const line = file ? `:${Math.max(1, Math.trunc(file.line ?? 1))}` : ''
  // `@` is kept as it is: it is legal in a path segment, and `me@box` reads better than `me%40box` in a link
  const target = encodeURIComponent(machine.sshTarget).replaceAll('%40', '@')
  return { ok: true, url: `vscode://vscode-remote/ssh-remote+${target}${path}${line}` }
}
