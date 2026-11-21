import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { powershell } from '../os.js'

/**
 * The Windows process table, read in milliseconds even on a starved machine (#2178): the one source of `pid ppid createdMs`
 * rows for a Windows stop and sweep (`kill-tree.ts`, `leftoverOs`). A one-off `Get-CimInstance Win32_Process` in a PowerShell
 * of its own took 0.3–0.7 s with up to 8 busy loops on 12 cores and 8.7–12 s with every core busy (measured 2026-11-10, Windows
 * 11, p50–p99), past the 3 s an ordered stop waits (`STOP_LIST_MS`); one PowerShell kept for the host's life and asked over
 * stdin answers in 1–4 ms at every load, at the cost of one resident process of about 80 MB, so only the long-lived host keeps
 * one (`warmProcessTable`). One `NtQuerySystemInformation(SystemProcessInformation)` call returns every process with parent and
 * creation time and opens none (Toolhelp32 has no creation time), declared at run time (Reflection.Emit) so nothing is compiled
 * or written to disk; `PreserveSig` keeps "buffer too small" a status. The offsets (creation time 0x20, pid 0x50, parent 0x58)
 * are the 64-bit layout, x64 and ARM64 alike, as System32's PowerShell is the 64-bit one; the rows matched CIM's, and a process
 * without a creation time (the idle process) is left out as CIM left it
 */
const READ_TABLE = [
  "$tb = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'CcProc'), 'Run').DefineDynamicModule('CcProc').DefineType('CcNt', 'Public,Class')",
  "$tb.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', 'Public,Static,PinvokeImpl', 'Standard', [int], [Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  '$nt = $tb.CreateType()',
  '$M = [Runtime.InteropServices.Marshal]',
  'function Read-Table {',
  '  $size = 1MB',
  '  while ($true) {',
  '    $buf = $M::AllocHGlobal($size)',
  '    $need = 0',
  '    $st = $nt::NtQuerySystemInformation(5, $buf, $size, [ref]$need)',
  '    if ($st -eq 0) { break }',
  '    $M::FreeHGlobal($buf)',
  // STATUS_INFO_LENGTH_MISMATCH: the table grew past the buffer, which is grown to what the call asks for and a margin
  '    if ($st -ne -1073741820) { throw "NtQuerySystemInformation status $st" }',
  '    $size = $need + 64KB',
  '  }',
  '  try {',
  '    $sb = New-Object Text.StringBuilder',
  '    $off = 0',
  '    do {',
  '      $p = [IntPtr]::Add($buf, $off)',
  '      $next = $M::ReadInt32($p, 0)',
  '      $ct = $M::ReadInt64($p, 0x20)',
  '      if ($ct -ne 0) {',
  "        [void]$sb.Append($M::ReadIntPtr($p, 0x50).ToInt64()).Append(' ').Append($M::ReadIntPtr($p, 0x58).ToInt64()).Append(' ').Append([long][Math]::Floor(($ct - 116444736000000000) / 10000)).Append(\"`n\")",
  '      }',
  '      $off += $next',
  '    } while ($next -ne 0)',
  '    $sb.ToString()',
  '  } finally { $M::FreeHGlobal($buf) }',
  '}',
].join('\n')

/** One read in a PowerShell of its own: where the warm one cannot answer (it would not start, or ended partway) */
export const READ_ONCE = `${READ_TABLE}\nRead-Table`

const SERVE = [
  READ_TABLE,
  '$o = [Console]::Out',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  try { $o.Write((Read-Table)) } catch { $o.Write("ERR $($_.Exception.Message)`n") }',
  '  $o.Write("END`n"); $o.Flush()',
  '}',
].join('\n')

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const

export type TableReader = {
  /** The table's rows as text; rejects with `killed` after `timeoutMs`, or with why it could not be read */
  read(timeoutMs: number): Promise<string>
  /** Starts the reader ahead of the first read, which on a starved machine takes 2–3 s to start: a stop cannot wait for that */
  warm(): void
  /** Ends the reader (a read waiting on it fails); a later read or `warm` starts another */
  stop(): void
}

/** What the reader needs of its PowerShell, a type of its own so a test can stand in for it */
export type ReaderProcess = {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(): boolean
  unref(): void
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (e: Error) => void): unknown
}

const startServer = (): ReaderProcess => spawn(powershell(), [...POWERSHELL_ARGS, SERVE], { windowsHide: true })

/**
 * The warm reader: one read at a time, started on `warm` or the first read and again after it ended. Neither it nor its pipes
 * hold the host open, and it ends with the host (stdin closes). A read that times out ends it, as its late answer would be
 * taken for the next read's
 */
export function tableReader(start: () => ReaderProcess = startServer): TableReader {
  let child: ReaderProcess | null = null
  let waiting: { resolve: (rows: string) => void; reject: (e: Error) => void } | null = null
  let queue: Promise<unknown> = Promise.resolve()

  function warm(): ReaderProcess {
    if (child) return child
    const c = start()
    child = c
    c.unref()
    for (const s of [c.stdin, c.stdout, c.stderr]) if (s instanceof Socket) s.unref()
    let out = ''
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (chunk: string) => {
      // A reader a timeout gave up on may still answer, and that answer belongs to no read now
      if (child !== c) return
      out += chunk
      const end = /(?:^|\n)END\n/.exec(out)
      if (!end) return
      // The rows, up to and with their last line's end
      const answer = out.slice(0, end.index + end[0].length - 'END\n'.length)
      out = out.slice(end.index + end[0].length)
      const w = waiting
      waiting = null
      if (answer.startsWith('ERR ')) w?.reject(new Error(answer.slice(4).trim()))
      else w?.resolve(answer)
    })
    c.stderr.resume()
    c.stdin.on('error', () => {}) // a write after it ended; its exit says so
    const gone = (e: Error) => {
      if (child !== c) return
      child = null
      const w = waiting
      waiting = null
      w?.reject(e)
    }
    c.on('error', gone)
    c.on('exit', (code) => gone(new Error(`the process table reader ended (${code})`)))
    return c
  }

  function readOnce(timeoutMs: number): Promise<string> {
    const c = warm()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null
        c.kill()
        /*
         * Its successor starts now, not at the next read: the start is the slow part (2.2 s measured on a loaded machine) and would
         * come out of that read's time limit
         */
        if (child === c) {
          child = null
          warm()
        }
        reject(Object.assign(new Error('timed out'), { killed: true }))
      }, timeoutMs)
      waiting = {
        resolve: (rows) => (clearTimeout(timer), resolve(rows)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      }
      c.stdin.write('t\n')
    })
  }

  return {
    warm: () => void warm(),
    stop: () => {
      const c = child
      if (!c) return
      child = null
      const w = waiting
      waiting = null
      c.kill()
      w?.reject(new Error('the process table reader was stopped'))
    },
    read: (timeoutMs) => {
      const r = queue.then(() => readOnce(timeoutMs))
      queue = r.catch(() => {})
      return r
    },
  }
}
