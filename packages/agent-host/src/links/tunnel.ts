import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { oneLineText } from '@cc/protocol'
import { createHash } from 'node:crypto'
import { asObj, tryParseJson } from '../json-value.js'
import { createConnection, createServer } from 'node:net'
import { win32 } from 'node:path'
import { hostname } from 'node:os'
import type { InstallSource, RemoteShell } from '@cc/protocol'
import { Tail } from '../stream-text.js'
import { endChild, runSsh, SshRunFailure, type SshExpectedLine, type SshRunResult } from './ssh-run.js'
import { isHostCrash, NodeTooOld } from './node-floor.js'

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
  /**
   * A full credential for this hub: since #1405 only `--connection --pair` prints one (`connectionCommand`), made for
   * the asker and kept there as its hash; an older remote prints its one token always. Absent from a line that was not
   * a pairing (`--detach`'s)
   */
  token?: string
  /** That credential's id (#1405), which the host's proof is made under (`RemoteClientOptions.credential`) */
  credential?: string
  /**
   * The full credentials that machine holds besides this hub's (#1405): `{ id, label, created }`, never their values.
   * Absent from a remote that predates it
   */
  others?: RemoteCredential[]
  /** The label this hub paired under at this link (#1405, `pairLabel`): another credential of it is not this hub's */
  pairedAs?: string
  version: string
  protocolVersion: number
  dataDir: string
  hostRunning: boolean
  /**
   * What runs `centralu` there (docs/plans/remote-hub.md §10.5): the install the hub manages, if any,
   * and the Node that answered. Absent from a remote that predates it
   */
  install?: RemoteInstall
  /**
   * Whether that machine starts its host at boot, and how it would (docs/plans/remote-hub.md §10.4,
   * owner decision 4). Absent from a remote that predates it
   */
  autostart?: RemoteAutostart
  /**
   * The options that remote's `serve` takes that an older one refuses (#1223): `from`, the hub's name on `--detach`,
   * which the host there writes to its `host.lock` so a second Centralu on that folder can say whose link holds it.
   * Absent from a remote that predates it, which is never sent one
   */
  takes?: string[]
  /**
   * The running host answered a `prove` (#838), so the hub asks it to prove it holds the token before sending it
   * (`RemoteClientOptions.proveHost`). Absent from a remote that predates it, which gets the hello as before
   */
  proof?: boolean
  /**
   * The person stopped Centralu there (#1143): `centralu serve --stop` (`stop`) or quitting Centralu there (`quit`), at
   * `at` when the mark says. Said only while no host runs. The hub then starts none by itself, until the person's
   * Start. Absent from a remote that predates it, which is started as before
   */
  stopped?: RemoteStop
}

/**
 * A full credential a linked machine holds, as its `--connection` names it (#1405): who it is for and since when.
 * `check`: the host's `credentialCheck` of the call's nonce under the entry's verifier (`host.credentials`), and `own`: the
 * hub's reading of it at that read (set by the link, never by the wire); neither reaches a row
 */
export type RemoteCredential = { id: string; label: string; created: number; replaced: boolean; gone?: boolean; check?: string; own?: boolean }

/** The `stopped` field of the connection line, as serve-files.mjs `readStopped` writes it */
export type RemoteStop = { by: 'stop' | 'quit'; at: number | null }

/**
 * The `autostart` field of the connection line, as `serve.mjs`'s `autostartInfo` writes it, and the
 * answer of `centralu serve --autostart`: `how` is what the machine uses (`systemd`, a scheduled `task`),
 * null where it offers nothing; `linger` whether systemd starts the user's manager at boot (else at login)
 */
export type RemoteAutostart = { on: boolean; how: 'systemd' | 'task' | null; linger: boolean | null }

/** The `install` field of the connection line, as `serve.mjs`'s `installInfo` writes it */
export type RemoteInstall = {
  /** Started by the managed launcher in `<data>/remote/bin/` (not an npm install) */
  managed: boolean
  /** `source`: a dev build made there from a commit (`pnpm remote-dev`, #1036), from its `install.json` */
  current: { version: string; node: string; source?: InstallSource } | null
  previous: { version: string; node: string; source?: InstallSource } | null
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
  exec?(command: RemoteCommand): Promise<RemoteRun>
  /** The transport went away by itself (the ssh process exited) */
  onDown(listener: (reason: string) => void): void
  close(): Promise<void>
}

/**
 * Reads the one JSON line `--connection` prints; anything else on stdout is not ours. `spec` is the remote's, for the
 * words of the update to tell the person when there is no line (`npmInstall`)
 */
export function parseConnectionLine(stdout: string, spec?: RemoteSpec): ConnectionLine {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = tryParseJson(lines[i]!)
    if (raw === undefined) continue
    const o = raw as Partial<ConnectionLine>
    if (o && typeof o === 'object' && typeof o.v === 'number') {
      if (o.v !== 1) throw new Error(`The remote's Centralu speaks connection format ${o.v}; update Centralu on this computer`)
      // A token is required only of a remote that does not pair (#1405): an older one always printed it
      const takes: unknown = asObj(raw).takes
      const pairs = Array.isArray(takes) && takes.includes('pair')
      if (typeof o.port !== 'number' || (typeof o.token !== 'string' && !pairs) || typeof o.protocolVersion !== 'number') {
        throw new Error('The remote answered with an incomplete connection line')
      }
      const install = parseInstall((o as { install?: unknown }).install)
      const autostart = parseAutostart((o as { autostart?: unknown }).autostart)
      return {
        v: 1,
        port: o.port,
        ...(typeof o.token === 'string' ? { token: o.token } : {}),
        ...(typeof o.credential === 'string' && /^[0-9a-f]{8}$/.test(o.credential) ? { credential: o.credential } : {}),
        ...othersOf((o as { others?: unknown }).others),
        version: typeof o.version === 'string' ? o.version : 'unknown',
        protocolVersion: o.protocolVersion,
        dataDir: typeof o.dataDir === 'string' ? o.dataDir : '',
        hostRunning: o.hostRunning === true,
        ...(install ? { install } : {}),
        ...(autostart ? { autostart } : {}),
        ...((o as { proof?: unknown }).proof === true ? { proof: true } : {}),
        ...stoppedOf((o as { stopped?: unknown }).stopped),
        ...takesOf((o as { takes?: unknown }).takes),
      }
    }
  }
  throw new Error(`The remote did not print a connection line; its Centralu may predate \`${shimNames(spec).centralu} serve\` (update it there: ${npmInstall(spec)})`)
}

/** The `others` field (#1405), entry by entry (`credentialsOf`) */
function othersOf(raw: unknown): { others?: RemoteCredential[] } {
  const others = credentialsOf(raw)
  return others ? { others } : {}
}

/**
 * A machine's full credentials as its connection line or `host.credentials` lists them (#1405), entry by entry: an id
 * `--revoke` takes, a label of one line with no format character, a date that is one; anything else is left out. Every
 * entry is read, however many (#1405 review): the row shows 32 and counts the rest, and a count cut at some bound would
 * hide what lies past it, which the host accepts all the same. The list is no longer than `serve.json`, which the host
 * reads whole at each hello anyway. Null for anything but a list
 */
export function credentialsOf(raw: unknown): RemoteCredential[] | null {
  // Also `host.credentials`' `usedUnderHubLabels` (#1405 review), whose entries are read the same way
  if (!Array.isArray(raw)) return null
  return raw.flatMap((e: unknown) => {
    const o = asObj(e)
    if (typeof o.id !== 'string' || !/^[0-9a-f]{8}$/.test(o.id) || typeof o.label !== 'string') return []
    const created = typeof o.created === 'number' && Number.isFinite(o.created) && o.created > 0 && o.created < 8.64e15 ? o.created : 0
    // An entry that carries a public key is a hub's key entry (#1711): no secret and so no check, and never the verifier credential this hub holds under its id (`own: false`; #1717 recheck, F1)
    const keyed = typeof o.publicKey === 'string'
    return [{ id: o.id, label: oneLineText(o.label, 80), created, replaced: o.replaced === true, ...(o.gone === true ? { gone: true } : {}), ...(keyed ? { own: false } : typeof o.check === 'string' && o.check.length <= 64 ? { check: o.check } : {}) }]
  })
}

/** The `stopped` field, field by field: any object there is a stop; its `by` and `at` only as the words they can be */
function stoppedOf(raw: unknown): { stopped?: RemoteStop } {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as { by?: unknown; at?: unknown }
  return { stopped: { by: o.by === 'quit' ? 'quit' : 'stop', at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : null } }
}

/** The `takes` field: the names in it that are words, or nothing */
function takesOf(raw: unknown): { takes?: string[] } {
  if (!Array.isArray(raw)) return {}
  const takes = raw.filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,32}$/.test(t))
  return takes.length ? { takes } : {}
}

/**
 * This computer's name as a remote's `serve --detach --from` takes it (#1223): letters, digits, `.`, `_` and `-`, at
 * most 64 of them, so it can go on any of the three remote shells' command lines unquoted. Null when nothing of it is left
 */
export function hubNameForRemote(name: string): string | null {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return clean || null
}

/** The `install` field, field by field; a field of the wrong shape is read as absent, never trusted */
function parseInstall(raw: unknown): RemoteInstall | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pointer = (v: unknown) => {
    const p = v as { version?: unknown; node?: unknown; source?: unknown } | null
    if (!p || typeof p.version !== 'string' || typeof p.node !== 'string') return null
    // A dev build made there from a commit (#1036): only a well-formed one is said
    const s = p.source as { kind?: unknown; commit?: unknown; dirty?: unknown } | null | undefined
    const source = s && s.kind === 'dev' && typeof s.commit === 'string' && /^[0-9a-f]{7,64}$/.test(s.commit) ? { kind: 'dev' as const, commit: s.commit, dirty: s.dirty === true } : null
    return { version: p.version, node: p.node, ...(source ? { source } : {}) }
  }
  return { managed: o.managed === true, current: pointer(o.current), previous: pointer(o.previous), node: typeof o.node === 'string' ? o.node : null }
}

/** The `autostart` field, field by field; null when it is not one */
export function parseAutostart(raw: unknown): RemoteAutostart | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.on !== 'boolean') return null
  const how = o.how === 'systemd' || o.how === 'task' ? o.how : null
  return { on: o.on && how !== null, how, linger: typeof o.linger === 'boolean' ? o.linger : null }
}

/** What `centralu serve --detach` answered (`serve.mjs`'s `runDetach`) */
export type DetachAnswer =
  | { ok: true; line: ConnectionLine; how: string | null }
  | { ok: false; reason: string; message: string; node?: string }

/**
 * `serve --detach` started a host there and it never answered (`exited`, `timeout`): a host that crashes at boot
 * (#1143 review). The link counts it against its limit of starts, as one that answered and then stopped; a start where
 * nothing could be started (ssh, no Centralu there, WMI refusing) is not this
 */
export class StartedNotServing extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartedNotServing'
  }
}

/** Reads the one JSON line `--detach` prints; throws when there is none */
export function parseDetachLine(stdout: string): DetachAnswer {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = tryParseJson(lines[i]!)
    if (raw === undefined) continue
    const d = asObj(raw).detach
    if (!d || typeof d !== 'object') continue
    const o = asObj(d)
    if (o.ok === true) return { ok: true, line: parseConnectionLine(lines[i]!), how: typeof o.how === 'string' ? o.how : null }
    return {
      ok: false,
      reason: typeof o.reason === 'string' ? o.reason : 'failed',
      message: typeof o.message === 'string' ? o.message : 'centralu serve --detach failed',
      ...(typeof o.node === 'string' ? { node: o.node } : {}),
    }
  }
  throw new Error('The remote did not say whether it started')
}

/** For tests and for a host the hub can reach directly: no transport, the address is given */
export class DirectTunnel implements Tunnel {
  constructor(private readonly line: () => ConnectionLine | Promise<ConnectionLine>) {}
  async open(): Promise<Endpoint> {
    const line = await this.line()
    return { url: `ws://127.0.0.1:${line.port}`, token: line.token ?? '', line, localPort: line.port }
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

export const WSL_DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Why WSL would not take `name` as a distro name, or null when it would. The one rule for it: `machines.add` refuses
 * such a name in these words, and so does every command built for a WSL remote, where the name goes on the line unquoted
 */
export function wslDistroError(name: string | null | undefined): string | null {
  return WSL_DISTRO_RE.test(name ?? '') ? null : `Not a WSL distro name: ${name || '(none)'}`
}

/** The spec's distro, checked by `wslDistroError` */
function distroOf(spec: RemoteSpec): string {
  const why = wslDistroError(spec.wslDistro)
  if (why) throw new Error(why)
  return spec.wslDistro!
}

/**
 * What every PowerShell script sent to a Windows remote starts with. The first line makes its output UTF-8.
 * The second gives it the machine's module path: a Windows PowerShell started from PowerShell 7 (pwsh)
 * inherits pwsh's `PSModulePath`, whose first folder holds 7.x copies of the built-in modules that 5.1
 * cannot load, and `Get-FileHash`, `ConvertTo-Json`, `Invoke-WebRequest` and `Expand-Archive` are then
 * "found in the module … but the module could not be loaded". That is every GitHub Windows runner, and a
 * Windows machine whose OpenSSH `DefaultShell` is pwsh.
 *
 * Only a path with a `\PowerShell\` folder in it (7's: `Program Files\PowerShell\7\Modules`, `Documents\PowerShell\Modules`;
 * Windows PowerShell's are all `\WindowsPowerShell\`) is replaced, by the two folders Windows PowerShell 5.1 has by
 * default. Not by `[Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')`: a script that merely contained
 * that call made the installer's step that runs Node take 5 to 7 s instead of 1.2 s on a Windows 11 PC (measured
 * 2026-10-16, against five other one-line additions that all stayed at 1.2 s), and the same on every start after it.
 */
export const PS_PREAMBLE =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8\nif ($env:PSModulePath -match '\\x5cPowerShell\\x5c') { $env:PSModulePath=\"$env:ProgramFiles\\WindowsPowerShell\\Modules;$PSHOME\\Modules\" }\n"

/** A PowerShell script as one command line any Windows shell passes on untouched (see `RemoteSpec`) */
export function powershell(script: string): string {
  const full = `${PS_PREAMBLE}${script}`
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(full, 'utf16le').toString('base64')}`
}

/**
 * One command for the other end of ssh, and, when it is too long for one command line, what to feed
 * its stdin. `exec` sends `stdin` and closes it. `expect`: the lines the remote prints as it gets on with it, in order
 * (`STDIN_READY`, once its PowerShell runs; `STDIN_ACK`, once it has read all of `stdin`); `exec` ends the run when one does not
 * come in time (`SshTunnelOptions.stdinReadyMs`, `stdinAckMs`), instead of waiting out the step's whole limit on a remote
 * that never saw its input (#1360)
 */
export type RemoteCommand = string | { command: string; stdin: string; expect?: readonly string[] }

/**
 * The longest command sent inline to a Windows remote. Windows OpenSSH runs a command through the
 * account's default shell, which is cmd.exe unless `DefaultShell` says otherwise, and cmd.exe takes
 * 8,191 characters ("The command line is too long."). sshd wraps the command in `cmd.exe /c "…"`.
 * Measured on a Windows 11 PC with no DefaultShell (2026-10-11): the installer's step, about 20,000
 * characters as one `-EncodedCommand`, was refused there before PowerShell started.
 */
export const WINDOWS_INLINE_MAX = 7_900

/**
 * The framing of a script on a Windows remote's stdin (#1360): base64 of its UTF-8, then a line that holds one dot
 * (base64 has none, so no line of the script is that line). The reader stops at that line and does not wait for the end of
 * input.
 *
 * **Measured on a Windows 11 PC (OpenSSH 9.5, Windows PowerShell 5.1, 2026-10-20), a private sshd on loopback and the
 * installer's real command, 17,000 characters of stdin:** `[Console]::In.ReadToEnd()` never returned in 2 to 9 runs of
 * 30 one after another and in 13 to 18 of 30 ten at a time; `[Console]::In.ReadLine()` up to the dot line did not hang at
 * that size but did in 1 to 4 runs of 30 to 80 at 100,000 characters; a `StreamReader` over `OpenStandardInput()` hung in 5
 * of 6. The stream itself, read with `Read()` into a buffer until the dot line, did not hang in 200 of 200 runs at 17,000
 * and at 100,000 characters, five at a time, and read to its end it did not hang in 200 of 200 at 17,000. So the end of input
 * did arrive; the text readers of `[Console]::In` are what stalled, and the size of the script is not the cause (a run of
 * 70,000 characters passed and one of 17,000 hung). The bytes are read from the stream, and the end of input is not
 * needed.
 *
 * The reader prints `STDIN_READY` when it starts and `STDIN_ACK` once the whole script is read, before it runs the script: the
 * hub waits for both (`exec`), so a remote that never saw its input fails in seconds with that said, not after the step's 30
 * minutes, and a step is sent again only when PowerShell was up and the input did not arrive. A stream that ends before the
 * dot line (a cut input) runs nothing and says so.
 */
export const STDIN_END = '.'
/** What the reader prints when it starts (see `STDIN_END`) */
export const STDIN_READY = 'CENTRALU-STDIN-READY'
/** What the reader prints once the whole script is read (see `STDIN_END`) */
export const STDIN_ACK = 'CENTRALU-STDIN-OK'
/**
 * How long the reader waits, from the moment it says it runs, for the line with the dot (#1360 review). The hub's wait for the
 * confirmation (`SSH_STDIN_ACK_MS`) is longer, so when the hub gives up and sends the step again the first reader has already
 * ended on its own: it checks the time after every read and again before it confirms, so a reader that stalled and woke late
 * exits with 4 and runs nothing, and one that waits for input that never comes does not stay behind (the PowerShell, its
 * `cmd.exe` and `conhost.exe` of a failed step). Exit 4 prints nothing more.
 */
export const STDIN_READER_MS = 20_000
/**
 * How long PowerShell 5.1 may take to start (1.2 to 3.5 s on a Windows 11 PC under load, 2026-10-20). A reader that finds its process
 * older than this when it says it runs will not read: the hub's wait for it (`SSH_STDIN_READY_MS`) may be over, and the input is
 * already waiting in its pipe, so a PowerShell that comes up late would run a step the hub reported as not started
 */
export const SSH_POWERSHELL_START_MS = 30_000
/** The reader's exit codes: the input ended before its dot line; its own time ran out (or its PowerShell started too late). The only exits of the reader the hub may answer by sending the step again (`SshExpectedLine.endedCodes`) */
export const STDIN_EXIT_CUT = 3
export const STDIN_EXIT_LATE = 4
/** The reader (see `STDIN_END`): says it runs, takes the bytes up to the dot line within `deadlineMs`, confirms; `$s` is the text it read */
function readStdin(deadlineMs: number, startMs: number): string {
  return (
    `Write-Output '${STDIN_READY}'; $w=[Diagnostics.Stopwatch]::StartNew(); ` +
    // A PowerShell that took too long to start gets no input read (see `SSH_POWERSHELL_START_MS`); the process's age, on this machine's clock
    `if (([DateTime]::Now-[Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds -gt ${startMs}) { exit ${STDIN_EXIT_LATE} }; ` +
    '$i=[Console]::OpenStandardInput(); $m=New-Object IO.MemoryStream; $b=New-Object byte[] 65536; $g=$m.GetBuffer(); $d=$false; ' +
    // Each read waits for what is left of the deadline (ReadAsync, so a read that never returns still ends); the input ends with a
    // line holding one dot, whose line break is \n or \r\n
    `while ($true) { $t=$i.ReadAsync($b,0,65536); $r=${deadlineMs}-$w.ElapsedMilliseconds; if ($r -le 0 -or -not $t.Wait([int]$r)) { exit ${STDIN_EXIT_LATE} }; $k=$t.Result; ` +
    'if ($k -le 0) { break }; $m.Write($b,0,$k); $g=$m.GetBuffer(); $n=[int]$m.Length; ' +
    'if ($n -ge 2 -and $g[$n-1] -eq 10 -and ($g[$n-2] -eq 46 -or ($n -ge 3 -and $g[$n-2] -eq 13 -and $g[$n-3] -eq 46))) { $d=$true; break } }; ' +
    `if (-not $d) { [Console]::Error.WriteLine('The input ended before its end line'); exit ${STDIN_EXIT_CUT} }; ` +
    `if ($w.ElapsedMilliseconds -gt ${deadlineMs}) { exit ${STDIN_EXIT_LATE} }; ` +
    `$s=[Text.Encoding]::ASCII.GetString($g,0,[int]$m.Length); Write-Output '${STDIN_ACK}'`
  )
}
const PS_READ_STDIN = readStdin(STDIN_READER_MS, SSH_POWERSHELL_START_MS)

/** What reads a script from stdin on Windows (see `STDIN_END`): base64 of the script's UTF-8, characters outside base64 dropped (CRLF, the end line) */
const psFromStdin = (readerMs: number, startMs: number) =>
  `${readStdin(readerMs, startMs)}; $c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($s -replace '[^A-Za-z0-9+/=]',''))); & ([ScriptBlock]::Create($c))`

/** A script's base64 as the readers above frame it */
function framed(base64: string): string {
  return `${base64}\n${STDIN_END}\n`
}

/**
 * A PowerShell script for a Windows remote: inline as `-EncodedCommand` when it fits cmd.exe's line,
 * else a short reader inline and the script on stdin (measured with a 40 KB script, 2026-10-11)
 */
export function powershellScript(script: string, readerMs = STDIN_READER_MS, startMs = SSH_POWERSHELL_START_MS): RemoteCommand {
  const inline = powershell(script)
  if (inline.length <= WINDOWS_INLINE_MAX) return inline
  const full = `${PS_PREAMBLE}${script}`
  return { command: powershell(psFromStdin(readerMs, startMs)), stdin: framed(Buffer.from(full, 'utf8').toString('base64')), expect: [STDIN_READY, STDIN_ACK] }
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
  const distro = distroOf(spec)
  return `wsl.exe -d ${distro} --exec sleep infinity`
}

/**
 * `$d`, the data folder, and `$m`, the managed launcher's path in it (plan §10.1), in each shell: `CC_DATA_DIR` when
 * the ssh session has it, else `~/.centralu`, as `serve` and the installer resolve the data folder. The launcher
 * `serve` keeps is looked for in the same `$d` (`<data>/bin/`, serve-install.mjs), not at a path of its own
 */
export const MANAGED_SH = 'd="${CC_DATA_DIR:-$HOME/.centralu}"; m="$d/remote/bin/centralu"'
export const MANAGED_PS =
  "$d = if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:USERPROFILE '.centralu' }; $m = Join-Path $d 'remote\\bin\\centralu.cmd'"

/**
 * The npm and centralu commands to tell a person to type on the remote: PowerShell gets the `.cmd`
 * shims, as the bare names resolve to the `.ps1` ones a default execution policy blocks
 */
export function shimNames(spec: RemoteSpec | undefined): { npm: string; centralu: string } {
  return spec?.shell === 'powershell' ? { npm: 'npm.cmd', centralu: 'centralu.cmd' } : { npm: 'npm', centralu: 'centralu' }
}

/** The command to tell a person to install or update Centralu from npm there, in its shell's terms (`shimNames`) */
export function npmInstall(spec: RemoteSpec | undefined): string {
  return `${shimNames(spec).npm} i -g centralu`
}

/** Centralu is not found there: what the person types to install it and start it once */
function notInstalled(where: string, spec: RemoteSpec): Error {
  return new Error(`Centralu is not installed ${where} (run \`${npmInstall(spec)}\` there, then \`${shimNames(spec).centralu} serve\` once)`)
}

/** What the remote command prints when it finds no Centralu to run (`connectionCommand`) */
export const NOT_FOUND = 'CENTRALU-NOT-FOUND'

/**
 * The remote command that prints the connection line (docs/agent-host.md §4.7), in the remote
 * shell's terms: the managed launcher the hub's installer wrote (`<data>/remote/bin/centralu`,
 * `centralu.cmd` on Windows; docs/plans/remote-hub.md §10.1), else `centralu` on the PATH an ssh
 * command gets, else the launcher `serve` keeps (`<data>/bin/centralu`), else `NOT_FOUND` on
 * stdout. The managed launcher comes first, so a machine with both an npm install and one the hub
 * made runs the version the hub installed. `<data>` is `CC_DATA_DIR` there, else `~/.centralu`:
 * the rule `serve` and the installer (install.ts) use.
 *
 * **The fallback is decided on the remote, in one command, and "not found" is said on stdout.**
 * Exit codes do not survive the way there (measured on a Windows laptop, 2026-10-05): Windows
 * OpenSSH runs the command under PowerShell, which turns any failing command into 1, so a 127 from
 * WSL or from PowerShell itself arrives as 1, and a missing command can even arrive as 0.
 *
 * **PowerShell runs the `.cmd` shim, never the bare name.** npm installs three shims, `centralu`,
 * `centralu.cmd` and `centralu.ps1`, and a bare `centralu` in PowerShell resolves to the `.ps1`, which
 * Windows' default `Restricted` execution policy refuses ("running scripts is disabled on this
 * system"; measured on Windows 11, 2026-10-15). `centralu.cmd` is a batch file, which no policy
 * blocks, so the lookup names it. The same goes for `npm` (`shimNames`).
 *
 * **A WSL distro does not look on Windows' drives.** WSL puts Windows' PATH after its own, and
 * Windows' npm folder holds a `centralu` shim: measured, `command -v centralu` in the distro named
 * `/mnt/c/Users/<me>/AppData/Roaming/npm/centralu`, the Windows install. Running that from the
 * distro is never what the person meant, so `/mnt/*` is taken off PATH for the lookup.
 *
 * A POSIX remote runs the lookup under `sh -c`, so a login shell that is not POSIX (fish) runs it
 * too. `command`, the person's own (`RemoteSpec.command`), runs as given, with no fallback.
 */
export function connectionCommand(spec: RemoteSpec, pair: string | null = null): string {
  return remoteCommand(spec, pair ? `serve --connection --pair ${pair}` : 'serve --connection')
}

/**
 * A hub's key for its pair label (#1405, `SshTunnelOptions.hubKey`): the 8 hex characters of its own id
 * (`hubSelfId`, `hub-` and 4 random bytes, drawn once and kept in its store). Random, not its data folder's hash
 * (#1405 review): two hubs on computers of one name whose data folders sit at the same path took one label, and each
 * replaced the other's credential at each link
 */
export function hubKeyOf(hubSelfId: string): string {
  return /^hub-([0-9a-f]{8})$/.exec(hubSelfId)?.[1] ?? createHash('sha256').update(hubSelfId).digest('hex').slice(0, 8)
}

/**
 * The label a hub pairs as (#1405): `hub:` and this computer's name, cleaned as `--from` is (`hubNameForRemote`). A
 * hub pairs again at each link and so replaces its own credential there; the machine's other ones keep their labels.
 */
export function pairLabel(name: string, hubKey?: string): string {
  const key = hubKey && /^[0-9a-f]{1,16}$/.test(hubKey) ? `-${hubKey}` : ''
  return `hub:${(hubNameForRemote(name) ?? 'hub').slice(0, 56)}${key}`
}

/**
 * `centralu serve --detach` there, found the same way (`SshTunnel.startHost`, plan §10.4). `from` is this computer's
 * name (`hubNameForRemote`), passed only to a remote whose connection line says it takes it (#1223)
 */
export function detachCommand(spec: RemoteSpec, from: string | null = null): string {
  const name = from === null ? null : hubNameForRemote(from)
  return remoteCommand(spec, name ? `serve --detach --from ${name}` : 'serve --detach')
}

/**
 * `centralu serve --stop` there, found the same way (plan §10.4, S10): the running host stops in
 * order, asked over its own socket. The update, rollback and uninstall run it (update.ts).
 *
 * As the hub's own stop (`CENTRALU_STOP_BY=hub`, #1143): `serve --stop` then leaves no mark of the person's stop, and
 * the hub's next start (the update's) is not refused as one. An older serve ignores the variable and marks nothing
 * anyway. A command of the person's own runs as given, in a shell this cannot know, so it gets no variable; the hub
 * installs and updates nothing on such a machine.
 *
 * `forUpdate` (#1618): `CENTRALU_STOP_FOR=update` too, for a stop after which the hub starts a host there again (update.ts
 * `stopRemoteHost`): the host lists the turns it ends, which the next one continues. An older serve ignores it
 */
export function stopCommand(spec: RemoteSpec, o: { forUpdate: boolean }): string {
  return remoteCommand(spec, 'serve --stop', o.forUpdate ? 'update' : 'stop')
}

/** `centralu serve` in the foreground, found the same way: a host bound to the forward's own ssh session */
export function serveCommand(spec: RemoteSpec): string {
  return remoteCommand(spec, 'serve')
}

/**
 * `centralu serve --autostart on|off|status` there, found the same way (plan §10.4, owner decision 4):
 * the boot entry of the Centralu the lookup finds, written, removed or read by that Centralu itself
 * (links/autostart.ts). Only the lookup crosses ssh, as short as `--connection`'s, so it always fits
 * cmd.exe's line (`WINDOWS_INLINE_MAX`); the scheduled task's PowerShell, which is long, is built and
 * run there by `serve`, on a command line of its own
 */
export function autostartCommand(spec: RemoteSpec, action: 'on' | 'off' | 'remove' | 'status'): string {
  return remoteCommand(spec, `serve --autostart ${action}`)
}

/** `centralu serve --revoke <id>` there (#1405): one full credential withdrawn. `id` is 8 hex characters, checked by the caller's schema */
export function revokeCommand(spec: RemoteSpec, id: string): string {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error('A credential id is 8 hex characters')
  return remoteCommand(spec, `serve --revoke ${id}`)
}

/** `--revoke`'s line: whether there was one to withdraw, or null when it printed none (an older serve refused the option) */
export function parseRevoke(stdout: string): boolean | null {
  for (const l of stdout.split('\n').map((x) => x.trim()).reverse()) {
    const revoked = asObj(tryParseJson(l)).revoked
    if (typeof revoked === 'boolean') return revoked
  }
  return null
}

/** `centralu <args>` on the remote, in its shell's terms, through the lookup `connectionCommand` describes */
function remoteCommand(
  spec: RemoteSpec,
  args:
    | 'serve --connection'
    | 'serve --detach'
    | `serve --detach --from ${string}`
    | `serve --connection --pair ${string}`
    | `serve --revoke ${string}`
    | 'serve --stop'
    | 'serve'
    | 'serve --autostart on'
    | 'serve --autostart off'
    | 'serve --autostart remove'
    | 'serve --autostart status',
  /**
   * The hub's own stop (`stopCommand`): said to `serve` as `CENTRALU_STOP_BY=hub`, and one a host starts again after as
   * `CENTRALU_STOP_FOR=update` too (#1618)
   */
  hubStop: 'stop' | 'update' | null = null,
): string {
  const custom = spec.command?.trim() || null
  if (spec.shell === 'powershell') {
    if (custom) return powershell(`${custom} ${args}`)
    return powershell(
      `${hubStop ? "$env:CENTRALU_STOP_BY = 'hub'; " : ''}${hubStop === 'update' ? "$env:CENTRALU_STOP_FOR = 'update'; " : ''}${MANAGED_PS}; if (Test-Path $m) { & $m ${args} } ` +
        `elseif (Get-Command centralu.cmd -ErrorAction SilentlyContinue) { & centralu.cmd ${args} } ` +
        "else { $l = Join-Path $d 'bin\\centralu.cmd'; " +
        `if (Test-Path $l) { & $l ${args} } else { '${NOT_FOUND}' } }`,
    )
  }
  const lookup =
    `${hubStop ? 'CENTRALU_STOP_BY=hub; export CENTRALU_STOP_BY; ' : ''}${hubStop === 'update' ? 'CENTRALU_STOP_FOR=update; export CENTRALU_STOP_FOR; ' : ''}${MANAGED_SH}; if [ -x "$m" ]; then exec "$m" ${args}; ` +
    `elif command -v centralu >/dev/null 2>&1; then exec centralu ${args}; ` +
    `elif [ -x "$d/bin/centralu" ]; then exec "$d/bin/centralu" ${args}; ` +
    `else echo ${NOT_FOUND}; exit 127; fi`
  if (spec.shell === 'posix') return custom ? `${custom} ${args}` : `sh -c '${lookup}'`
  const distro = distroOf(spec)
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
export function remoteScript(spec: RemoteSpec, script: { sh: string; ps: string }): RemoteCommand {
  if (spec.shell === 'powershell') return powershellScript(script.ps)
  const b64 = Buffer.from(script.sh, 'utf8').toString('base64')
  if (spec.shell === 'posix') return `printf %s ${b64} | base64 -d | sh`
  const distro = distroOf(spec)
  const inline = powershell(`wsl.exe -d '${distro}' -- bash -lc 'echo ${b64} | base64 -d | bash -l'`)
  if (inline.length <= WINDOWS_INLINE_MAX) return inline
  // Too long for cmd.exe's line: the script on stdin, passed through to the distro (`-i`: PowerShell adds CRLF)
  return { command: powershell(`${PS_READ_STDIN}; $s | wsl.exe -d '${distro}' -- bash -lc 'base64 -di | bash -l'`), stdin: framed(b64), expect: [STDIN_READY, STDIN_ACK] }
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
  /** How long a short question to the remote (the connection line) may take, ssh's own connect time included */
  commandTimeoutMs?: number
  /** How long starting the remote's host (`centralu serve --detach`) may take: it waits for the host to answer before it does */
  detachTimeoutMs?: number
  /** How long a step of the installer, updater or autostart (`exec`) may take: a download on a slow link is part of it */
  execTimeoutMs?: number
  /** How long a step whose script goes on stdin may take to say its PowerShell runs (`RemoteCommand.expect`, #1360); `SSH_STDIN_READY_MS` when absent */
  stdinReadyMs?: number
  /** How long, from then, it may take to say it has read the script; `SSH_STDIN_ACK_MS` when absent */
  stdinAckMs?: number
  /** This computer's name, for `serve --detach --from` (#1223); the OS's host name when absent */
  hubName?: string
  /**
   * What tells this hub from another of the same name (#1405): its own random id (`hubKeyOf`). It ends the label
   * the hub pairs as, so two hubs on computers of one name (or a packaged app and a development host on one computer)
   * do not replace each other's credential at each link
   */
  hubKey?: string
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
 * - The first command falls back to `<data>/bin/centralu`, decided on the remote: an SSH shell is not
 *   interactive, and nvm, fnm, volta and `~/.npm-global` put npm's global folder on PATH only in
 *   interactive shells (§4.7 of agent-host.md, which is why `serve` keeps that launcher).
 * - The forward binds 127.0.0.1 on both ends, explicitly: never 0.0.0.0 and never `GatewayPorts`,
 *   so nothing on the hub's network can use the link.
 * - **The same port number on both ends** when it is free here, another one when it is taken
 *   (typically by a second linked machine on the default 17175). Nothing depends on it any more:
 *   app views of a linked machine are served by the hub on its own port (plan §11), never through
 *   this forward. Kept because the number reads the same in both machines' logs.
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
  /**
   * Forwards this tunnel ended on purpose (a reopen, a forward that did not come up in time): their
   * exit is not the link going down. Reported as down, a reopen of a live link made the link retry,
   * and that retry's reopen ended the new forward again, every few seconds without end
   */
  private readonly ended = new WeakSet<ChildProcess>()
  /** The remote cannot start a host outside a session (WMI blocked): the forward runs it (`startHost`) */
  private linkBound = false
  /** The last connection line said its `serve --detach` takes `--from` (#1223) */
  private takesFrom = false

  constructor(private readonly opts: SshTunnelOptions) {
    if (!opts.target.trim() || opts.target.startsWith('-')) throw new Error('Not an ssh target')
  }

  async open(): Promise<Endpoint> {
    // Before the wait, not after it: a `close()` while the old forward ends has to stay closed
    this.closing = false
    await this.stopChild()
    this.ifClosed()
    const line = await this.connectionLine().catch((err: unknown) => {
      this.ifClosed()
      throw err
    })
    this.ifClosed()
    this.takesFrom = line.takes?.includes('from') === true
    if (!line.hostRunning && !this.linkBound) {
      return { url: '', token: line.token ?? '', line, localPort: 0 }
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
    return { url: `ws://127.0.0.1:${localPort}`, token: served.token ?? '', line: served, localPort }
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
    const r = await this.run([...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target, detachCommand(remote, this.takesFrom ? (this.opts.hubName ?? hostname()) : null)], undefined, this.opts.detachTimeoutMs ?? SSH_DETACH_TIMEOUT_MS)
    this.ifClosed()
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    if (r.stdout.includes(NOT_FOUND) || (r.code === 127 && !remote.command)) throw notInstalled(this.where, remote)
    let answer: DetachAnswer
    try {
      answer = parseDetachLine(r.stdout)
    } catch (err) {
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
    // The launcher refused a Node below the floor, or its host crashed the way one crashes (#699)
    if (answer.reason === 'node_too_old') throw new NodeTooOld(answer.message, 'refused', answer.node ?? null)
    if (answer.reason === 'exited' && isHostCrash(answer.message)) throw new NodeTooOld(answer.message, 'crashed', null)
    if (answer.reason === 'exited' || answer.reason === 'timeout') throw new StartedNotServing(answer.message)
    throw new Error(answer.message)
  }

  /**
   * Runs one command there the way the connection line is asked for (batch mode, `--` before the
   * target), and answers what it printed. For the installer (install.ts): the command is already in
   * the remote shell's terms. `close()` ends it like any asking ssh
   */
  async exec(command: RemoteCommand): Promise<RemoteRun> {
    this.ifClosed()
    const line = typeof command === 'string' ? command : command.command
    const stdin = typeof command === 'string' ? undefined : command.stdin
    const markers: readonly string[] = typeof command === 'string' ? [] : (command.expect ?? [])
    const readyMs = this.opts.stdinReadyMs ?? SSH_STDIN_READY_MS
    const ackMs = this.opts.stdinAckMs ?? SSH_STDIN_ACK_MS
    const sec = (ms: number) => `${Math.round(ms / 1000)} seconds`
    const expect: SshExpectedLine[] = markers.map((marker, i) =>
      i === 0
        ? {
            marker,
            withinMs: readyMs,
            message: `${this.opts.target} did not start this step's PowerShell within ${sec(readyMs)} (ssh connecting, login and PowerShell starting)`,
          }
        : {
            marker,
            withinMs: ackMs,
            message: `PowerShell on ${this.opts.target} did not confirm within ${sec(ackMs)} that it had read this step's input, so the step did not start`,
            endedMessage: `PowerShell on ${this.opts.target} ended before it had read this step's input (its own time for that ran out, or the input was cut), so the step did not start`,
            // The reader's own exits (cut input, its time); a dropped link (255) or a signal is not, and is not sent again
            endedCodes: [STDIN_EXIT_CUT, STDIN_EXIT_LATE],
          },
    )
    const args = [...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target, line]
    let r: SshRunResult
    try {
      r = await this.run(args, stdin, this.opts.execTimeoutMs ?? SSH_EXEC_TIMEOUT_MS, expect)
    } catch (err) {
      /*
       * Only when PowerShell was up and the input was not read in time. That reader ends on its own `STDIN_READER_MS` after it
       * said it runs, less than the wait for its confirmation, and it checks the time again before it confirms, so by the time the
       * step is sent again the first reader is gone or never ran the script: the script runs only after the confirmation.
       * (The input is written with the command, not after PowerShell says it runs: written later, Windows OpenSSH did not deliver
       * it in 11 to 30 percent of the runs, and not at all 100 ms later; docs/runtime-lessons.md RE18.)
       */
      if (!(err instanceof SshRunFailure) || err.kind !== 'expected' || err.stage !== 1) throw err
      this.ifClosed()
      this.opts.log?.(`[ssh] ${err.message}; sending it once more`)
      try {
        r = await this.run(args, stdin, this.opts.execTimeoutMs ?? SSH_EXEC_TIMEOUT_MS, expect)
      } catch (again) {
        if (again instanceof SshRunFailure && again.kind === 'expected' && again.stage === 1) throw new Error(`${again.message}, twice. The input of a command is not reaching it`)
        throw again
      }
    }
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    // The reader's lines are not the step's output
    return markers.length ? { ...r, stdout: r.stdout.split(/\r?\n/).filter((l) => !markers.includes(l.trim())).join('\n') } : r
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
    for (const c of this.asking) void endChild(c)
    await this.stopChild()
  }

  private ifClosed(): void {
    if (this.closing) throw new Error(`The link to ${this.opts.target} was closed`)
  }

  /**
   * Runs ssh to the end and answers what it printed, within bounds (`runSsh`). Past `timeoutMs`, or once stdout is
   * longer than `SSH_STDOUT_LIMIT` characters, the ssh is stopped and this rejects: `ConnectTimeout` only
   * bounds the connection, and a remote command that never ends, or never stops printing, would
   * otherwise hold the call and its memory for good. Only the end of stderr is kept (`SSH_STDERR_KEEP`);
   * what it is read for is the last line. Closing the tunnel ends the ssh runs still in flight.
   */
  private run(args: string[], stdin: string | undefined, timeoutMs: number, expect?: readonly SshExpectedLine[]): Promise<SshRunResult> {
    let child: ChildProcess | null = null
    // Once the run has settled, a stopped ssh is `endChild`'s to finish: closing has nothing more to end
    return runSsh({ ssh: this.opts.ssh, args, env: this.opts.env, stdin, timeoutMs, expect, label: this.opts.target, onChild: (c) => this.asking.add((child = c)) }).finally(() => {
      if (child) this.asking.delete(child)
    })
  }

  private config(): string[] {
    return this.opts.configFile ? ['-F', this.opts.configFile] : []
  }

  /** An older remote refused `--pair` once (#1405): asked without it from then on, for this tunnel's life */
  private pairs = true

  /** The label this hub pairs as there (#1405, `pairLabel`): its computer's name and its own key */
  get pairsAs(): string {
    return pairLabel(this.opts.hubName ?? hostname(), this.opts.hubKey)
  }

  private async connectionLine(): Promise<ConnectionLine> {
    const remote = this.opts.remote ?? { shell: 'posix' }
    const base = [...this.config(), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', this.opts.target]
    /*
     * A full credential of this hub's own, made there at each link (#1405): `--connection` alone prints none since. A
     * remote from before it answers `--pair` with "unknown option", and is asked again as before, printing its token. Kept
     * as the update path for a machine below `MIN_SUPPORTED_VERSION` (#1143): `--pair` first shipped in 0.1.0-beta.45, so a
     * hub reads an older machine's version this way, holds its link and offers the update
     */
    const pair = this.pairs ? this.pairsAs : null
    let r = await this.run([...base, connectionCommand(remote, pair)], undefined, this.opts.commandTimeoutMs ?? SSH_COMMAND_TIMEOUT_MS)
    if (pair && r.code !== 0 && r.code !== 255 && /unknown option for serve: --pair/.test(r.stderr + r.stdout)) {
      this.pairs = false
      r = await this.run([...base, connectionCommand(remote)], undefined, this.opts.commandTimeoutMs ?? SSH_COMMAND_TIMEOUT_MS)
    }
    /*
     * A remote updated since it refused `--pair` says it takes it now, and prints no token without it: asked again with
     * it, once, rather than linking with no credential until this hub restarts (#1405 review)
     */
    if (!this.pairs && r.code === 0 && /"takes":\[[^\]]*"pair"/.test(r.stdout) && !/"token":/.test(r.stdout)) {
      this.pairs = true
      return this.connectionLine()
    }
    if (r.code === 255) throw new Error(`ssh could not reach ${this.opts.target}: ${lastLine(r.stderr) || 'no answer'}`)
    if (r.stdout.includes(NOT_FOUND) || (r.code === 127 && !remote.command)) throw notInstalled(this.where, remote)
    try {
      const line = parseConnectionLine(r.stdout, remote)
      // Under which label this hub's own credential was made: another of that label on the row is not this hub's
      return pair && this.pairs && line.credential ? { ...line, pairedAs: oneLineText(pair, 80) } : line
    } catch (err) {
      // No line: say what the remote said on the way out, if anything
      const why = lastLine(r.stderr)
      // Its serve.json may not be read there (#1405 review): the launcher's own advice, not a guess at an older Centralu
      if (r.code !== 0 && /cannot be read by this user \((EACCES|EPERM)\)/.test(why)) throw new Error(why.replace(/^centralu serve: /, ''))
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
    const child = spawn(this.opts.ssh ?? 'ssh', args, { env: this.opts.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    /*
     * Only the end is kept: this ssh lives as long as the link, and in link-bound mode the remote host's
     * own log goes through it. What is read from it is the last line, for the reason the link ended.
     */
    const kept = new Tail(FORWARD_STDERR_KEEP)
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => kept.push(d))
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
        if (!settled) return fail(`The ssh forward to ${this.opts.target} ended (${signal ?? code}): ${lastLine(kept.text) || 'no reason given'}`)
        if (!this.closing && !this.ended.has(child)) for (const l of this.downListeners) l(`ssh exited (${signal ?? code})${kept.text ? `: ${lastLine(kept.text)}` : ''}`)
      })
      const poll = async () => {
        while (!settled) {
          if (await accepts(localPort)) {
            settled = true
            this.opts.log?.(`[links] forward up: 127.0.0.1:${localPort} -> ${this.opts.target}:127.0.0.1:${remotePort}`)
            return resolve()
          }
          if (Date.now() > deadline) {
            this.ended.add(child)
            void endChild(child)
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
    this.ended.add(child)
    await endChild(child)
  }
}

/** How long a short question to the remote may take before its ssh is stopped (`SshTunnelOptions.commandTimeoutMs`) */
export const SSH_COMMAND_TIMEOUT_MS = 60_000
/**
 * How long starting the remote's host may take (`SshTunnelOptions.detachTimeoutMs`). `serve --detach` itself
 * waits up to 30 s for the host to answer, on top of ssh's connect time and a cold Windows start, and
 * what it says when that runs out is a better reason than the one this deadline gives.
 */
export const SSH_DETACH_TIMEOUT_MS = 120_000
/**
 * How long one installer, updater or autostart step may take (`SshTunnelOptions.execTimeoutMs`). The
 * managed Windows install downloads about 30 MB of Node inside one step, and a slow link needs minutes
 * for that: this is far past what a working link needs, and only ends a step that is stuck.
 */
export const SSH_EXEC_TIMEOUT_MS = 30 * 60_000
/**
 * What ssh may spend connecting and logging in before it counts against a step's PowerShell (`SSH_STDIN_READY_MS`, #1360 review):
 * `ConnectTimeout=15` is per address, and a name with several addresses or a ProxyJump chain tries them one after another.
 * Six attempts' worth; a connection that is slower than that is not one a step should wait for
 */
export const SSH_CONNECT_ALLOWANCE_MS = 6 * 15_000
/**
 * How long a step whose script goes on stdin may take to start its PowerShell and say so (`RemoteCommand.expect`,
 * `SshTunnelOptions.stdinReadyMs`, #1360): ssh's own connecting has its allowance (`SSH_CONNECT_ALLOWANCE_MS`) on top of PowerShell's
 * start, so a slow connection is not reported as a PowerShell that did not start. A connection that fails says so itself (exit 255)
 */
export const SSH_STDIN_READY_MS = SSH_CONNECT_ALLOWANCE_MS + SSH_POWERSHELL_START_MS
/**
 * How long, from the reader saying it runs, the step may take to say it has read its script (`SshTunnelOptions.stdinAckMs`):
 * 17 KB through a link that is up. More than the reader's own wait (`STDIN_READER_MS`, 20 s), which ends first. Past it the input did
 * not arrive in time, the step has not started, and it is sent once more
 */
export const SSH_STDIN_ACK_MS = 30_000
/** How much of the end of the forward's stderr is kept, for as long as the link lives */
const FORWARD_STDERR_KEEP = 16 * 1024

/** A tag or an escape of PowerShell's CLIXML (`_x000D__x000A_` is a line break, `_x001B_` an ESC) */
const CLIXML_MARK = /<\/?(?:Objs|Obj|S|MS|PR|TN|TNRef|Props|I32|I64|B|AV)[\s>/]|_x00[0-9A-F]{2}_/

/** A terminal escape sequence (colour and the like), which PowerShell 7 puts in its errors: none of it is text */
// eslint-disable-next-line no-control-regex -- ESC is what the pattern is about
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]?/g

/**
 * One line of an error record as the person should read it, or null for a line that only says where in the script the
 * error was. Windows PowerShell 5.1 writes those under the message: `At line:4 char:1` (in the machine's
 * language: `위치 줄:4 문자:1` on a Korean one, measured; `At C:\x.ps1:12 char:5` in a script),
 * `+ throw 'x'`, `+ ~~~~`, `+ CategoryInfo : …`. PowerShell 7's ConciseView writes them as a gutter around the
 * message: `Line |`, `   4 |  throw 'x'`, `     |  ~~~~`, then `     | x`, the message itself. The position line is
 * known by its whole shape (a word, then `<where>:<n> <word>:<n>`), so a message that only ends in `b.log:12 col:5` stays.
 */
function powershellErrorLine(line: string): string | null {
  const l = line.trim()
  if (l === '+' || l.startsWith('+ ')) return null
  if (/^\S+ \S+:\d+ \S+:\d+$/.test(l) || /^(?:At|위치) .+:\d+ \S+:\d+$/.test(l)) return null
  if (/^Line \|$/.test(l) || /^\d+ \|/.test(l) || /^\|\s*~*$/.test(l)) return null
  const gutter = /^\| ?(.*)$/.exec(l)
  return gutter ? gutter[1]! : line
}

/**
 * The text of the whole error records (`<S S="Error">`) in a piece of CLIXML, its escapes read back
 * and without the lines that say where in the script the error was
 */
function clixmlErrorText(xml: string): string {
  return [...xml.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) =>
      m[1]!
        .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!),
    )
    .join('')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .flatMap((l) => {
      const kept = powershellErrorLine(l)
      return kept === null ? [] : [kept]
    })
    .join('\n')
}

/** Text outside the XML, up to the first line that shows a tag or an escape: from there it is XML that was cut */
function plainPart(text: string): string {
  const mark = text.search(CLIXML_MARK)
  return mark < 0 ? text : text.slice(0, text.lastIndexOf('\n', mark) + 1)
}

/**
 * What a stderr says once PowerShell's CLIXML is read (#1081). Windows PowerShell writes its `#< CLIXML`
 * header before its first record, often a progress record ("Preparing modules for first use") at the
 * start, and the records as `<Objs>…</Objs>` blocks. What a command it runs writes to stderr itself
 * comes between the header and the blocks, and its own errors are the blocks' `<S S="Error">` records.
 * So the header and the progress go, the text around and between the blocks and the error records'
 * text are kept. A kept tail (`Tail`) can start in the middle of a block, and then only its tags and
 * escapes say what it is: from the start of the first line that shows either up to that block's end,
 * it is XML, and only the whole error records in it are read.
 */
function withoutClixml(s: string): string[] {
  let text = s.replace(/^#< CLIXML\r?$/gm, '')
  const parts: string[] = []
  const firstEnd = text.indexOf('</Objs>')
  const firstOpen = text.search(/<Objs[\s>]/)
  if (firstEnd >= 0 && (firstOpen < 0 || firstEnd < firstOpen)) {
    const cut = plainPart(text.slice(0, firstEnd))
    parts.push(cut, '\n', clixmlErrorText(text.slice(cut.length, firstEnd)), '\n')
    text = text.slice(firstEnd + '</Objs>'.length)
  }
  for (;;) {
    const open = text.search(/<Objs[\s>]/)
    if (open < 0) break
    parts.push(plainPart(text.slice(0, open)), '\n')
    const end = text.indexOf('</Objs>', open)
    // A stream that stops inside a block (the process was ended mid-write) keeps the block's whole records
    parts.push(clixmlErrorText(end < 0 ? text.slice(open) : text.slice(open, end)), '\n')
    text = end < 0 ? '' : text.slice(end + '</Objs>'.length)
  }
  parts.push(plainPart(text))
  return parts.join('').replace(ANSI, '').split(/\r?\n/)
}

/**
 * The one line of a remote's stderr that says why, for the person. Measured on a Windows laptop
 * (2026-10-05): ssh prefixes its own `** WARNING` lines about key exchange, PowerShell wraps an
 * error in CLIXML when its output is not a console (read by `withoutClixml`), and a Node crash ends
 * with `Node.js v22.x`, which says nothing. Those are skipped; a line that names an error wins over
 * the last one.
 */
export function lastLine(s: string, ansi: (bytes: Buffer) => string | null = ansiText): string {
  const lines = withoutClixml(s)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !/^Node\.js v\d/.test(l) && !/^at /.test(l))
  const line = [...lines].reverse().find((l) => /error|denied|refused|timed out|not found|cannot|could not/i.test(l)) ?? lines.at(-1) ?? ''
  return unescapeBytes(line, ansi)
}

/**
 * A line of ssh's own with the bytes it would not print put back as text (#849).
 *
 * ssh writes the bytes of its messages that it does not take for printable text as octal escapes (OpenSSH's `strnvis`).
 * Windows' OpenSSH gets a system error's text in the ANSI code page, so on a Korean machine "Could not resolve hostname
 * x: 알려진 호스트가 없습니다." reached the person as `x: \276\313\267\301…` (measured with OpenSSH_for_Windows 9.5p2).
 * A run of escapes is read as UTF-8, or else in the ANSI code page. Only a run of bytes from 0x80 up is ssh's: it prints
 * ASCII as it is, so `\123` in a Windows path (`C:\123\x`) stays as written.
 */
export function unescapeBytes(line: string, ansi: (bytes: Buffer) => string | null = ansiText): string {
  return line.replace(/(?:\\[23][0-7]{2})+/g, (run) => {
    const bytes = Buffer.from(run.slice(1).split('\\').map((o) => parseInt(o, 8)))
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return ansi(bytes) ?? run
    }
  })
}

/** TextDecoder's names for the ANSI code pages whose number is not its name (`windows-1252` and the like are) */
const CODE_PAGE_NAMES: Record<string, string> = { '932': 'shift_jis', '936': 'gbk', '949': 'euc-kr', '950': 'big5', '65001': 'utf-8' }
let ansiDecoder: TextDecoder | null | undefined

/**
 * Bytes in this Windows machine's ANSI code page as text; null elsewhere, or when they do not decode. The code page is
 * read from the registry once, the first time it is needed: a failed ssh is rare, and Node has no other way to ask.
 */
function ansiText(bytes: Buffer): string | null {
  if (ansiDecoder === undefined) {
    ansiDecoder = null
    if (process.platform !== 'win32') return null
    try {
      const root = process.env.SystemRoot && win32.isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows'
      const out = execFileSync(win32.join(root, 'System32', 'reg.exe'), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const page = /\bACP\s+REG_SZ\s+(\d+)/.exec(out)?.[1]
      if (page) ansiDecoder = new TextDecoder(CODE_PAGE_NAMES[page] ?? `windows-${page}`, { fatal: true })
    } catch {
      // no registry answer, or a code page TextDecoder does not know: the escapes stay
    }
  }
  try {
    return ansiDecoder?.decode(bytes) ?? null
  } catch {
    return null
  }
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
