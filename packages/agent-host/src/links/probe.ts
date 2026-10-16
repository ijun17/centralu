import type { MachineProbe } from '@cc/protocol'
import { runSsh, SshRunFailure } from './ssh-run.js'
import { lastLine, powershell, WSL_DISTRO_RE } from './tunnel.js'

/**
 * What runs at the other end of an ssh target, asked once before it is linked (#514), so the Add
 * machine dialog offers "Windows", "WSL (Ubuntu)" or "Linux or macOS" instead of asking for a shell.
 *
 * **One command for every shell.** The probe is `powershell -NoProfile -NonInteractive
 * -EncodedCommand <base64>`, the way every Windows command is already sent (tunnel.ts), because it is
 * the one line that means the same thing to the three shells an ssh command can land in:
 *
 *   cmd.exe     Windows OpenSSH's default shell when no `DefaultShell` is set, which runs
 *               `cmd.exe /c "<command>"` and so starts PowerShell
 *   PowerShell  a `DefaultShell` of powershell.exe or pwsh.exe: it starts PowerShell too
 *   sh          has no `powershell`, and says so with exit 127, POSIX's "command not found"
 *
 * Nothing else crosses: base64 is letters, digits, `+`, `/` and `=`, which no shell re-parses, and
 * the whole line is about 1,700 characters, far under cmd.exe's 8,191 (`WINDOWS_INLINE_MAX`, #489).
 *
 * **What the script reads, all of it from the registry, nothing started and nothing written:**
 * `HKLM\SOFTWARE\OpenSSH\DefaultShell`, which is where Windows OpenSSH itself reads the shell it runs
 * a command under (empty: cmd.exe), and the WSL distros registered for the account under
 * `HKCU\...\Lxss`, which is where `wsl.exe -l` reads them, with `DefaultDistribution` marking the
 * default. Reading the registry rather than running `wsl.exe -l` avoids its UTF-16 output and does not
 * start the WSL service.
 */

export const PROBE_MARK = 'CENTRALU-PROBE'

const PROBE_PS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$l = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'",
  '$d = (Get-ItemProperty -LiteralPath $l).DefaultDistribution',
  `"${PROBE_MARK} platform=$([Environment]::OSVersion.Platform)"`,
  `"${PROBE_MARK} shell=$((Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\OpenSSH').DefaultShell)"`,
  'Get-ChildItem -LiteralPath $l | ForEach-Object { $n = (Get-ItemProperty -LiteralPath $_.PSPath).DistributionName; ' +
    `if ($n) { if ($_.PSChildName -eq $d) { "${PROBE_MARK} wsl-default=$n" } else { "${PROBE_MARK} wsl=$n" } } }`,
].join('\n')

/** The probe's one command line (above) */
export function probeCommand(): string {
  return powershell(PROBE_PS)
}

/**
 * What the probe's run says. `code` is ssh's exit code: 255 is ssh's own failure (not reached, a
 * key refused, a host key not known), anything else is the remote shell's
 */
export function parseProbe(target: string, run: { code: number | null; stdout: string; stderr: string }): MachineProbe {
  const base = { sshTarget: target, windowsShell: null, wslDistros: [], error: null }
  if (run.code === 255) return { ...base, reachable: false, os: null, error: lastLine(run.stderr) || 'ssh could not reach it' }
  const facts = new Map<string, string[]>()
  for (const raw of run.stdout.split('\n')) {
    const m = new RegExp(`^${PROBE_MARK} ([a-z-]+)=(.*)$`).exec(raw.replace(/\r$/, '').trim())
    if (m) facts.set(m[1]!, [...(facts.get(m[1]!) ?? []), m[2]!.trim()])
  }
  const platform = facts.get('platform')?.[0]
  if (platform?.startsWith('Win')) {
    const shell = (facts.get('shell')?.[0] ?? '').replace(/^"|"$/g, '')
    const exe = shell.split(/[\\/]/).pop()!.toLowerCase()
    const windowsShell = !shell || exe === 'cmd.exe' ? 'cmd' : exe === 'powershell.exe' ? 'powershell' : exe === 'pwsh.exe' ? 'pwsh' : 'other'
    // docker-desktop's own distros are not places to run Centralu; a name WSL would not take is not offered
    const distro = (name: string) => WSL_DISTRO_RE.test(name) && !/^docker-desktop/i.test(name)
    const wslDistros = [
      ...(facts.get('wsl-default') ?? []).filter(distro).map((name) => ({ name, default: true })),
      ...(facts.get('wsl') ?? []).filter(distro).map((name) => ({ name, default: false })),
    ]
    return { ...base, reachable: true, os: 'windows', windowsShell, wslDistros }
  }
  // PowerShell on a Unix (pwsh installed as `powershell`) answered for a Unix shell
  if (platform === 'Unix') return { ...base, reachable: true, os: 'posix' }
  // No PowerShell there: a POSIX shell says so with 127 (sh, bash, dash, zsh, fish); csh's words differ
  if (run.code === 127 || /powershell: (command )?not found|not found: powershell|Unknown command:? .?powershell/i.test(run.stderr)) {
    return { ...base, reachable: true, os: 'posix' }
  }
  return { ...base, reachable: true, os: null, error: lastLine(run.stderr) || (run.code ? `It answered with exit ${run.code} and nothing Centralu reads` : 'It answered nothing Centralu reads') }
}

export type ProbeOptions = {
  ssh?: string
  /** `ssh -F`, for tests */
  configFile?: string
  env?: NodeJS.ProcessEnv
  /** The whole run, connection included; ssh's own `ConnectTimeout` is 10 s */
  timeoutMs?: number
}

/**
 * Runs the probe over the person's own ssh, BatchMode as every link does: a password, a passphrase
 * or an unknown host key fails at once instead of waiting for an answer nobody can give
 */
export function probeTarget(target: string, opts: ProbeOptions = {}): Promise<MachineProbe> {
  const t = target.trim()
  if (!t || t.startsWith('-') || /\s/.test(t)) {
    return Promise.reject(Object.assign(new Error('Not an ssh target: use a host alias from ~/.ssh/config, or user@host'), { code: 'internal' }))
  }
  const args = [...(opts.configFile ? ['-F', opts.configFile] : []), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', t, probeCommand()]
  /*
   * A run that did not get to its end is not reached: what it says is the reason. The probe's answer is a few short
   * lines, so the default bounds on output are far past it.
   */
  return runSsh({ ssh: opts.ssh, args, env: opts.env, timeoutMs: opts.timeoutMs ?? 30_000, label: t }).then(
    (run) => parseProbe(t, run),
    (e: unknown) => {
      const kind = e instanceof SshRunFailure ? e.kind : 'spawn'
      const why = kind === 'timeout' ? `ssh to ${t} did not answer in time` : kind === 'spawn' ? `Could not run ssh: ${(e as Error).message}` : (e as Error).message
      return parseProbe(t, { code: 255, stdout: '', stderr: why })
    },
  )
}
