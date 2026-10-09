import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import type { RemoteShell } from '@cc/protocol'

/**
 * The way from the hub to a linked machine's host (docs/plans/remote-hub.md §2).
 *
 * Behind an interface because where the transport lives is still open: phase 1 runs the person's
 * own `ssh` as a child of the hub host (`SshTunnel`), and probe 4 decides whether it moves to a
 * keeper child (it would then survive a hub swap) or to OpenSSH's `ControlPersist` (it would
 * survive any host restart). Whatever wins only has to answer `open` and report `down`.
 */

/** What `centralu serve --connection` prints on the remote (docs/agent-host.md §4.7) */
export type ConnectionLine = {
  v: number
  port: number
  token: string
  version: string
  protocolVersion: number
  dataDir: string
  hostRunning: boolean
  /**
   * What runs `centralu` there (docs/plans/remote-hub.md §10.5): the install the hub manages, if any,
   * and the Node that answered. Absent from a remote that predates it
   */
  install?: RemoteInstall
}

/** The `install` field of the connection line, as `serve.mjs`'s `installInfo` writes it */
export type RemoteInstall = {
  /** Started by the managed launcher in `<data>/remote/bin/` (not an npm install) */
  managed: boolean
  current: { version: string; node: string } | null
  previous: { version: string; node: string } | null
  /** The Node that ran `--connection` */
  node: string | null
}

/**
 * How the hub got a remote host running that was not (owner decision 7, plan §10.9):
 *
 *   detached    `centralu serve --detach`: it lives until it is stopped, the machine restarts or
 *               it crashes, whatever happens to the link
 *   link_bound  WMI process creation is blocked there (decision 3), so the forward's own ssh session
 *               runs `centralu serve`; the host ends when the link does
 */
export type HostStart = { how: 'detached' | 'link_bound'; note: string | null }

/** What one remote command printed, and its exit code as ssh passed it on (`Tunnel.exec`) */
export type RemoteRun = { code: number | null; stdout: string; stderr: string }

export type Endpoint = {
  /** Where the hub connects: always the hub's own loopback */
  url: string
  token: string
  line: ConnectionLine
  /** The local end of the forward. Equal to `line.port` unless that port was taken here (see `SshTunnel`) */
  localPort: number
}

export interface Tunnel {
  /**
   * Opens the way, or reopens it after `down`. Rejects with a message for the person when the
   * machine cannot be reached or its answer cannot be read. Resolves without a forward when the
   * remote's host is not running (`line.hostRunning` false): there is nothing to forward to yet.
   */
  open(): Promise<Endpoint>
  /**
   * Starts the remote's host when `open` found none running (`line.hostRunning` false), so that the
   * next `open` finds it. Rejects with a message for the person when it cannot. Absent where the hub
   * cannot start anything (a direct tunnel)
   */
  startHost?(): Promise<HostStart>
  /**
   * Runs one command on the remote, in its shell's terms, and answers what it printed (the installer,
   * install.ts). Rejects when the machine cannot be reached. Absent where there is no shell (a direct tunnel)
   */
  exec?(command: string): Promise<RemoteRun>
  /** The transport went away by itself (the ssh process exited) */
  onDown(listener: (reason: string) => void): void
  close(): Promise<void>
}

/** Reads the one JSON line `--connection` prints; anything else on stdout is not ours */
export function parseConnectionLine(stdout: string): ConnectionLine {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    const o = raw as Partial<ConnectionLine>
    if (o && typeof o === 'object' && typeof o.v === 'number') {
      if (o.v !== 1) throw new Error(`The remote's Centralu speaks connection format ${o.v}; update Centralu on this computer`)
      if (typeof o.port !== 'number' || typeof o.token !== 'string' || typeof o.protocolVersion !== 'number') {
        throw new Error('The remote answered with an incomplete connection line')
      }
      const install = parseInstall((o as { install?: unknown }).install)
      return {
        v: 1,
        port: o.port,
        token: o.token,
        version: typeof o.version === 'string' ? o.version : 'unknown',
        protocolVersion: o.protocolVersion,
        dataDir: typeof o.dataDir === 'string' ? o.dataDir : '',
        hostRunning: o.hostRunning === true,
        ...(install ? { install } : {}),
      }
    }
  }
  throw new Error('The remote did not print a connection line; its Centralu may predate `centralu serve` (update it there: npm i -g centralu)')
}

/** The `install` field, field by field; a field of the wrong shape is read as absent, never trusted */
function parseInstall(raw: unknown): RemoteInstall | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pointer = (v: unknown) => {
    const p = v as { version?: unknown; node?: unknown } | null
    return p && typeof p.version === 'string' && typeof p.node === 'string' ? { version: p.version, node: p.node } : null
  }
  return { managed: o.managed === true, current: pointer(o.current), previous: pointer(o.previous), node: typeof o.node === 'string' ? o.node : null }
}

/** What `centralu serve --detach` answered (`serve.mjs`'s `runDetach`) */
export type DetachAnswer =
  | { ok: true; line: ConnectionLine; how: string | null }
  | { ok: false; reason: string; message: string }

/** Reads the one JSON line `--detach` prints; throws when there is none (a remote older than `--detach`) */
export function parseDetachLine(stdout: string): DetachAnswer {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    const d = (raw as { detach?: { ok?: unknown; how?: unknown; reason?: unknown; message?: unknown } } | null)?.detach
    if (!d || typeof d !== 'object') continue
    if (d.ok === true) return { ok: true, line: parseConnectionLine(lines[i]!), how: typeof d.how === 'string' ? d.how : null }
    return { ok: false, reason: typeof d.reason === 'string' ? d.reason : 'failed', message: typeof d.message === 'string' ? d.message : 'centralu serve --detach failed' }
  }
  throw new Error('The remote did not say whether it started')
}

/** For tests and for a host the hub can reach directly: no transport, the address is given */
export class DirectTunnel implements Tunnel {
  constructor(private readonly line: () => ConnectionLine | Promise<ConnectionLine>) {}
  async open(): Promise<Endpoint> {
    const line = await this.line()
    return { url: `ws://127.0.0.1:${line.port}`, token: line.token, line, localPort: line.port }
  }
  onDown(): void {}
  async close(): Promise<void> {}
}

/**
 * What runs a command on the other end of ssh. `ssh <target> <command>` hands the command to the
 * remote account's login shell, which differs by machine (measured on a Windows laptop, 2026-10-05):
 *
 *   posix       a Unix shell (Linux, macOS)
 *   powershell  Windows OpenSSH, whose default shell is PowerShell 5.1 (or cmd.exe)
 *   wsl         a Linux distro inside WSL on that Windows machine. WSL2 forwards the distro's
 *               127.0.0.1 ports to Windows' 127.0.0.1, so the forward to the Windows side reaches a
 *               host listening on loopback inside WSL with no change
 *
 * Every layer between the hub and the remote command re-parses quotes its own way (PowerShell 5.1
 * mangles a double quote passed to a native program), so anything that is not a plain word travels
 * encoded: PowerShell's own `-EncodedCommand` (UTF-16LE base64), and for WSL a base64 script fed to
 * `bash -l` on stdin. Base64 is letters, digits, `+`, `/` and `=`, which no layer touches.
 */
export type RemoteSpec = {
  shell: RemoteShell
  /** The WSL distro, for `wsl` (`wsl.exe -l -v` lists them) */
  wslDistro?: string | null
  /**
   * What to run in place of `centralu`, in that shell's syntax, when it is not on the remote's
   * PATH and not at the launcher `serve` keeps: a source checkout, a custom data folder
   * (`CC_DATA_DIR=/tmp/x node /src/packaging/npm/centralu/bin/centralu.mjs`). ` serve --connection`
   * is appended
   */
  command?: string | null
}

const WSL_DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/

function powershell(script: string): string {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}`
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(full, 'utf16le').toString('base64')}`
}

/**
 * What the forward's ssh session runs on a WSL remote: a process inside the distro for as long as
 * the link is up. Measured on a Windows laptop (2026-10-05): WSL stops a distro about 15 s after its
 * last `wsl.exe` client exits, and stopping it stops every service in it, `centralu serve` under
 * systemd included (journal: "Stopping cc-probe-serve.service" 19 s after it started, with no
 * client attached). A bare `-N` forward reaches Windows' sshd and never touches the distro, so the
 * link would hold a forward to a host that is gone. Null for any other shell.
 */
export function wslKeepAlive(spec: RemoteSpec | undefined): string | null {
  if (spec?.shell !== 'wsl') return null
  const distro = spec.wslDistro ?? ''
  if (!WSL_DISTRO_RE.test(distro)) throw new Error(`Not a WSL distro name: ${distro || '(none)'}`)
  return `wsl.exe -d ${distro} --exec sleep infinity`
}

/**
 * `$m`, the managed launcher's path (plan §10.1), in each shell: under `CC_DATA_DIR` when the ssh
 * session has it, else under `~/.centralu`, as `serve` and the installer resolve the data folder
 */
export const MANAGED_SH = 'm="${CC_DATA_DIR:-$HOME/.centralu}/remote/bin/centralu"'
export const MANAGED_PS =
  "$d = if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:USERPROFILE '.centralu' }; $m = Join-Path $d 'remote\\bin\\centralu.cmd'"

/** What the remote command prints when it finds no Centralu to run (`connectionCommand`) */
export const NOT_FOUND = 'CENTRALU-NOT-FOUND'

/**
 * The remote command that prints the connection line (docs/agent-host.md §4.7), in the remote
 * shell's terms: the managed launcher the hub's installer wrote (`<data>/remote/bin/centralu`,
 * `centralu.cmd` on Windows; docs/plans/remote-hub.md §10.1), else `centralu` on the PATH an ssh
 * command gets, else the launcher `serve` keeps (`~/.centralu/bin/centralu`), else `NOT_FOUND` on
 * stdout. The managed launcher comes first, so a machine with both an npm install and one the hub
 * made runs the version the hub installed. `<data>` is `CC_DATA_DIR` there, else `~/.centralu`:
 * the rule `serve` and the installer (install.ts) use.
 *
 * **The fallback is decided on the remote, in one command, and "not found" is said on stdout.**
 * Exit codes do not survive the way there (measured on a Windows laptop, 2026-10-05): Windows
 * OpenSSH runs the command under PowerShell, which turns any failing command into 1, so a 127 from
 * WSL or from PowerShell itself arrives as 1, and a missing command can even arrive as 0.
 *
 * **A WSL distro does not look on Windows' drives.** WSL puts Windows' PATH after its own, and
 * Windows' npm folder holds a `centralu` shim: measured, `command -v centralu` in the distro named
 * `/mnt/c/Users/<me>/AppData/Roaming/npm/centralu`, the Windows install. Running that from the
 * distro is never what the person meant, so `/mnt/*` is taken off PATH for the lookup.
 *
 * A POSIX remote runs the lookup under `sh -c`, so a login shell that is not POSIX (fish) runs it
 * too. `command`, the person's own (`RemoteSpec.command`), runs as given, with no fallback.
 */
export function connectionCommand(spec: RemoteSpec): string {
  return remoteCommand(spec, 'serve --connection')
}

/** `centralu serve --detach` there, found the same way (`SshTunnel.startHost`, plan §10.4) */
export function detachCommand(spec: RemoteSpec): string {
  return remoteCommand(spec, 'serve --detach')
}

/**
 * `centralu serve --stop` there, found the same way (plan §10.4, S10): the running host stops in
 * order, asked over its own socket. The update, rollback and uninstall run it (update.ts)
 */
export function stopCommand(spec: RemoteSpec): string {
  return remoteCommand(spec, 'serve --stop')
}

/** `centralu serve` in the foreground, found the same way: a host bound to the forward's own ssh session */
export function serveCommand(spec: RemoteSpec): string {
  return remoteCommand(spec, 'serve')
}

/** `centralu <args>` on the remote, in its shell's terms, through the lookup `connectionCommand` describes */
function remoteCommand(spec: RemoteSpec, args: 'serve --connection' | 'serve --detach' | 'serve --stop' | 'serve'): string {
  const custom = spec.command?.trim() || null
  if (spec.shell === 'powershell') {
    if (custom) return powershell(`${custom} ${args}`)
    return powershell(
      `${MANAGED_PS}; if (Test-Path $m) { & $m ${args} } ` +
        `elseif (Get-Command centralu -ErrorAction SilentlyContinue) { & centralu ${args} } ` +
        "else { $l = Join-Path $env:USERPROFILE '.centralu\\bin\\centralu.cmd'; " +
        `if (Test-Path $l) { & $l ${args} } else { '${NOT_FOUND}' } }`,
    )
  }
  const lookup =
    `${MANAGED_SH}; if [ -x "$m" ]; then exec "$m" ${args}; ` +
    `elif command -v centralu >/dev/null 2>&1; then exec centralu ${args}; ` +
    `elif [ -x "$HOME/.centralu/bin/centralu" ]; then exec "$HOME/.centralu/bin/centralu" ${args}; ` +
    `else echo ${NOT_FOUND}; exit 127; fi`
  if (spec.shell === 'posix') return custom ? `${custom} ${args}` : `sh -c '${lookup}'`
  const distro = spec.wslDistro ?? ''
  if (!WSL_DISTRO_RE.test(distro)) throw new Error(`Not a WSL distro name: ${distro || '(none)'}`)
  const script = custom
    ? `${custom} ${args}`
    : `PATH=$(printf %s "$PATH" | tr : '\\n' | grep -v '^/mnt/' | paste -sd: -); ${lookup}`
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  return powershell(`wsl.exe -d '${distro}' -- bash -lc 'echo ${b64} | base64 -d | bash -l'`)
}

/**
 * A script in the remote shell's terms (the installer, install.ts), sent the way `remoteCommand`
 * sends its lookup: base64 piped to `sh` on POSIX (so a login shell like fish runs it too), and to
 * `bash -l` inside a WSL distro; PowerShell's own `-EncodedCommand` on Windows.
 */
export function remoteScript(spec: RemoteSpec, script: { sh: string; ps: string }): string {
  if (spec.shell === 'powershell') return powershell(script.ps)
  const b64 = Buffer.from(script.sh, 'utf8').toString('base64')
  if (spec.shell === 'posix') return `printf %s ${b64} | base64 -d | sh`
  const distro = spec.wslDistro ?? ''
  if (!WSL_DISTRO_RE.test(distro)) throw new Error(`Not a WSL distro name: ${distro || '(none)'}`)
  return powershell(`wsl.exe -d '${distro}' -- bash -lc 'echo ${b64} | base64 -d | bash -l'`)
}

export type SshTunnelOptions = {
  /** What the person typed: a host alias from ~/.ssh/config, or user@host */
  target: string
  /** The remote's shell (posix when absent) */
  remote?: RemoteSpec
  /** An ssh config file in place of the person's own (`ssh -F`). Probes and tests only */
  configFile?: string
  /** The ssh binary. Tests put a fake one on PATH instead */
  ssh?: string
  env?: NodeJS.ProcessEnv
  /** How long the forward may take to start accepting connections */
  forwardTimeoutMs?: number
  /** How long a host the forward runs (link-bound) may take to answer */
  startTimeoutMs?: number
  log?: (line: string) => void
}

/**
 * The person's own `ssh`, twice: once to ask the remote how to reach its host, and once, held open,
 * for the forward.
 *
 *   ssh -T -o BatchMode=yes <target> centralu serve --connection
 *   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L 127.0.0.1:<port>:127.0.0.1:<port> <target>
 *
 * - `BatchMode=yes` everywhere: a password or host-key prompt nobody can answer would hang the hub
 *   forever. The person's keys, agent and `~/.ssh/config` are used as they are.
 * - The first command falls back to `~/.centralu/bin/centralu` on exit 127: an SSH shell is not
 *   interactive, and nvm, fnm, volta and `~/.npm-global` put npm's global folder on PATH only in
 *   interactive shells (§4.7 of agent-host.md, which is why `serve` keeps that launcher).
 * - The forward binds 127.0.0.1 on both ends, explicitly: never 0.0.0.0 and never `GatewayPorts`,
 *   so nothing on the hub's network can use the link.
 * - **The same port number on both ends** when it is free here (agent-host.md §4.7: an app view's
 *   address carries the host's own port). When it is taken, typically by a second linked machine
 *   on the default 17175, a free port is used instead; app views of that machine then need the
 *   proxy of phase 2, which they need anyway.
 * - **Closing ends every ssh it started**, the held forward and an asking one still in flight, also
 *   when `close()` comes in the middle of `open()` (a machine removed while it connects): `open()`
 *   then starts nothing more and fails.
 * - ssh stays in the host's process group, unlike an agent CLI (`adapters/local-process.ts`, #435):
 *   whatever supervises the host ends that group with it (`host_proc.rs`'s `kill_group`), and a
 *   forward, which reads no stdin, would otherwise outlive a host that died without `close()`. What
 *   ssh itself starts here (a `ProxyCommand`, `ProxyJump`'s second ssh) ssh ends on SIGTERM.
 */
export class SshTunnel implements Tunnel {
  private child: ChildProcess | null = null
  /** The asking ssh runs, while they run */
  private readonly asking = new Set<ChildProcess>()
  private downListeners: ((reason: string) => void)[] = []
  private closing = false
  /** The remote cannot start a host outside a session (WMI blocked): the forward runs it (`startHost`) */
  private linkBound = false

  constructor(private readonly opts: SshTunnelOptions) {
    if (!opts.target.trim() || opts.target.startsWith('-')) throw new Error('Not an ssh target')
  }

  async open(): Promise<Endpoint> {
    await this.stopChild()
    this.closing = false
    const line = await this.connectionLine().catch((err: unknown) => {
      this.ifClosed()
      throw err
    })
    this.ifClosed()
    if (!line.hostRunning && !this.linkBound) {
      return { url: '', token: line.token, line, localPort: 0 }
    }
    // A link-bound host is started by the forward itself (`startHost`), so it is not running yet here
    const hosting = !line.hostRunning
    let localPort = (await portFree(line.port)) ? line.port : await freePort()
    try {
      await this.forward(localPort, line.port, hosting)
    } catch (err) {
      // Taken between the check and ssh's bind: once more on a port the OS picks
      if (localPort !== line.port) throw err
      this.ifClosed()
      localPort = await freePort()
      await this.forward(localPort, line.port, hosting)
    }
    if (this.closing) {
      await this.stopChild()
      this.ifClosed()
    }
    const served = hosting ? await this.untilServing() : line
    return { url: `ws://127.0.0.1:${localPort}`, token: served.token, line: served, localPort }
  }

  /**
   * Where Centralu runs, for a sentence: "on <target>", or "in WSL (<distro>) on <target>" (#482).
   * A Windows laptop can be linked twice, as Windows and as a distro, and both rows used to say
   * "on <target>" alike.
   */
  private get where(): string {
    const remote = this.opts.remote
    if (remote?.shell !== 'wsl') return `on ${this.opts.target}`
    return `in WSL (${remote.wslDistro || 'its default distro'}) on ${this.opts.target}`
  }

  /**
   * Starts the remote's host with `centralu serve --detach` (plan §10.4, owner decision 7): it then
   * runs outside any ssh session and outlives this link. When the remote says WMI process creation
   * is blocked there (decision 3), every `open` from then on runs `centralu serve` as the forward's
   * own remote command instead, so the host lives as long as the link.
   */
  async startHost(): Promise<HostStart> {
    this.ifClosed()
    const remote = this.opts.remote ?? { shell: 'posix' }
    const r = await this.run([...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target, detachCommand(remote)])
    this.ifClosed()
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    if (r.stdout.includes(NOT_FOUND) || (r.code === 127 && !remote.command)) {
      throw new Error(`Centralu is not installed ${this.where} (run \`npm i -g centralu\` there, then \`centralu serve\` once)`)
    }
    let answer: DetachAnswer
    try {
      answer = parseDetachLine(r.stdout)
    } catch (err) {
      if (/unknown option for serve: --detach/.test(r.stderr)) {
        throw new Error(`Centralu on ${this.opts.target} is too old to be started from here: run \`centralu serve\` there, or update it (npm i -g centralu)`)
      }
      const why = lastLine(r.stderr)
      throw new Error(`${(err as Error).message}${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}`)
    }
    if (answer.ok) {
      this.linkBound = false
      return { how: 'detached', note: null }
    }
    if (answer.reason === 'wmi_blocked') {
      this.linkBound = true
      return { how: 'link_bound', note: answer.message }
    }
    throw new Error(answer.message)
  }

  /**
   * Runs one command there the way the connection line is asked for (batch mode, `--` before the
   * target), and answers what it printed. For the installer (install.ts): the command is already in
   * the remote shell's terms. `close()` ends it like any asking ssh
   */
  async exec(command: string): Promise<RemoteRun> {
    this.ifClosed()
    const r = await this.run([...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target, command])
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    return r
  }

  /** The connection line again until the link-bound host answers, or the forward that runs it ends */
  private async untilServing(): Promise<ConnectionLine> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000)
    for (;;) {
      this.ifClosed()
      if (!this.child) throw new Error(`The ssh session that runs Centralu on ${this.opts.target} ended before it served`)
      const line = await this.connectionLine()
      if (line.hostRunning) return line
      if (Date.now() > deadline) {
        await this.stopChild()
        throw new Error(`Centralu on ${this.opts.target} did not start serving in time`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  onDown(listener: (reason: string) => void): void {
    this.downListeners.push(listener)
  }

  async close(): Promise<void> {
    this.closing = true
    for (const c of this.asking) c.kill('SIGTERM')
    await this.stopChild()
  }

  private ifClosed(): void {
    if (this.closing) throw new Error(`The link to ${this.opts.target} was closed`)
  }

  private run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.ssh ?? 'ssh', args, { env: this.opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      this.asking.add(child)
      child.once('exit', () => this.asking.delete(child))
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d: Buffer) => (stdout += String(d)))
      child.stderr!.on('data', (d: Buffer) => (stderr += String(d)))
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  private config(): string[] {
    return this.opts.configFile ? ['-F', this.opts.configFile] : []
  }

  private async connectionLine(): Promise<ConnectionLine> {
    const remote = this.opts.remote ?? { shell: 'posix' }
    const base = [...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target]
    const r = await this.run([...base, connectionCommand(remote)])
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    if (r.stdout.includes(NOT_FOUND) || (r.code === 127 && !remote.command)) {
      throw new Error(`Centralu is not installed ${this.where} (run \`npm i -g centralu\` there, then \`centralu serve\` once)`)
    }
    try {
      return parseConnectionLine(r.stdout)
    } catch (err) {
      // No line: say what the remote said on the way out, if anything
      const why = lastLine(r.stderr)
      throw new Error(`${(err as Error).message}${why ? `: ${why}` : r.code ? ` (exit ${r.code})` : ''}`)
    }
  }

  private forward(localPort: number, remotePort: number, hosting = false): Promise<void> {
    this.ifClosed()
    /*
     * A forward alone runs nothing; for WSL it runs the keep-alive instead (`wslKeepAlive`), and for a
     * link-bound host it runs the host itself, which also holds a WSL distro for as long as it runs.
     * When this ssh ends, the remote's sshd ends that session: Windows' OpenSSH ends its processes,
     * and on posix the launcher takes the hangup as a stop and stops its host in order.
     */
    const keepAlive = hosting ? serveCommand(this.opts.remote ?? { shell: 'posix' }) : wslKeepAlive(this.opts.remote)
    const args = [
      ...this.config(),
      ...(keepAlive ? ['-T'] : ['-N']),
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'GatewayPorts=no',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      '--', this.opts.target,
      ...(keepAlive ? [keepAlive] : []),
    ]
    const child = spawn(this.opts.ssh ?? 'ssh', args, { env: this.opts.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => (stderr += String(d)))
    return new Promise((resolve, reject) => {
      let settled = false
      const deadline = Date.now() + (this.opts.forwardTimeoutMs ?? 20_000)
      const fail = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      child.once('error', (e) => fail(`Could not start ssh: ${e.message}`))
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null
        if (!settled) return fail(`The ssh forward to ${this.opts.target} ended (${signal ?? code}): ${lastLine(stderr) || 'no reason given'}`)
        if (!this.closing) for (const l of this.downListeners) l(`ssh exited (${signal ?? code})${stderr ? `: ${lastLine(stderr)}` : ''}`)
      })
      const poll = async () => {
        while (!settled) {
          if (await accepts(localPort)) {
            settled = true
            this.opts.log?.(`[links] forward up: 127.0.0.1:${localPort} -> ${this.opts.target}:127.0.0.1:${remotePort}`)
            return resolve()
          }
          if (Date.now() > deadline) {
            child.kill('SIGTERM')
            return fail(`The ssh forward to ${this.opts.target} did not come up in time`)
          }
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      void poll()
    })
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000).unref()
    })
  }
}

/**
 * The one line of a remote's stderr that says why, for the person. Measured on a Windows laptop
 * (2026-10-05): ssh prefixes its own `** WARNING` lines about key exchange, PowerShell wraps an
 * error in CLIXML when its output is not a console, and a Node crash ends with `Node.js v22.x`,
 * which says nothing. Those are skipped; a line that names an error wins over the last one.
 */
export function lastLine(s: string): string {
  const lines = s
    .replace(/#< CLIXML[\s\S]*$/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !/^Node\.js v\d/.test(l) && !/^at /.test(l))
  return [...lines].reverse().find((l) => /error|denied|refused|timed out|not found|cannot|could not/i.test(l)) ?? lines.at(-1) ?? ''
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}
