import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { endsWorkWithJob, systemTool } from '../os.js'

/**
 * **The host's work ends with it on Windows** (#1067, #840 item 7, owner's option b).
 *
 * Windows does not end a process's children when it ends. Node (libuv) puts each child it starts into a job of its
 * own that ends that child with the host, but lets the child's own children leave it silently, and node-pty's ConPTY
 * children are in no job at all. So whatever an agent CLI, a terminal, a Run command or an app server started through
 * a program that is not Node (codex's MCP servers and shell commands, a dev server PowerShell started, `start`) kept
 * running after a crash, a quit or a host swap, holding its ports and memory (measured on Windows 11: every such
 * grandchild survived `taskkill /F` of the host).
 *
 * At start the host puts **itself** into a new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and holds the only
 * handle to it, not inheritable. Every process it starts from then on, and everything those start, is created in that
 * job (nested under libuv's, which Windows 8 and later allow); when the host ends, however it ends, its handle closes
 * and Windows ends them all. The host itself rather than each child: a child added by its pid after the spawn could
 * already have started its own (cmd.exe runs its command at once), while a child of a process in a job is in it from
 * its creation, in all five ways the host starts one.
 *
 * - **What the host opens for the person** is not in it: there is nothing the host itself opens. "Open in IDE" and
 *   `system.openUrl` are opened by the window, outside the host's tree. What the person starts from a terminal is part
 *   of that terminal's tree: a program already running (a browser, an editor) takes the request in its own process and
 *   is untouched; one that was not running starts inside the job and ends with the host.
 * - **No breakaway** (`JOB_OBJECT_LIMIT_BREAKAWAY_OK` is not set): the host starts nothing that needs it, and with it
 *   allowed, what Git for Windows' sh (MSYS) started left the job: a git hook's, or anything under Git Bash (Claude
 *   Code's Bash tool on Windows), outlived the host (measured with the real host; without it, it ended, and the hook ran
 *   as before).
 * - **A host swap:** the next host is started by the window, not by this host, so it is in no job of this one's.
 * - **Already in a job** (a Node launcher's under `pnpm dev`, a CI runner's): the new job nests inside it (measured
 *   under a Node parent). Where Windows refuses (an outer job that forbids it), the host goes on as before and says so
 *   in its log.
 *
 * Node has no Job Object API. One PowerShell (~0.4–0.8 s on Windows 11, almost all of it PowerShell starting) creates
 * the job, puts the host in it, copies the handle into the host and exits. It runs while the host opens its store, and
 * the host waits for it before it starts anything (`START_ORDER`'s `work job`). A native addon would be a build step
 * per architecture for one call; the keeper could own the job once Windows has one (docs/plans/runtime-unification.md
 * step 9), but today the window starts the host directly, and `pnpm dev` and a Windows remote's `serve` would not be
 * covered.
 */

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` alone (no breakaway, see the file header) */
export const WORK_JOB_LIMITS = 0x2000

/**
 * Creates the job, sets its limits, copies the handle into the process (not inheritable: a child holding it would
 * keep the job, and its processes, alive past the host), puts the process in the job and closes its own handles.
 * Prints `ok`, or the step that failed and Windows' error number.
 */
const JOIN_SCRIPT = (pid: number, limits: number) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CentraluWorkJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr handle, IntPtr toProcess, out IntPtr copy, int access, bool inherit, int options);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Join(int pid, uint limits) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) return "create " + Marshal.GetLastWin32Error();
    try {
      Extended info = new Extended();
      info.BasicLimitInformation.LimitFlags = limits;
      if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) return "limits " + Marshal.GetLastWin32Error();
      // PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_DUP_HANDLE
      IntPtr host = OpenProcess(0x0100 | 0x0001 | 0x0040, false, pid);
      if (host == IntPtr.Zero) return "open " + Marshal.GetLastWin32Error();
      try {
        IntPtr copy;
        // DUPLICATE_SAME_ACCESS, not inheritable
        if (!DuplicateHandle(GetCurrentProcess(), job, host, out copy, 0, false, 2)) return "handle " + Marshal.GetLastWin32Error();
        if (!AssignProcessToJobObject(job, host)) return "assign " + Marshal.GetLastWin32Error();
        return "ok";
      } finally { CloseHandle(host); }
    } finally { CloseHandle(job); }
  }
}
'@
[CentraluWorkJob]::Join(${pid}, ${limits})
`

/** What joining the job came to */
export type WorkJob = { state: 'joined' } | { state: 'not needed' } | { state: 'failed'; reason: string }

/** What joining needs from the system, as a parameter so it can be tested anywhere */
export type WorkJobOs = {
  /** Whether this system needs the job at all (`endsWorkWithJob`) */
  needed: boolean
  /** Runs a PowerShell script and answers what it printed */
  powershell: (script: string) => Promise<string>
}

const run = promisify(execFile)
const REAL_OS: WorkJobOs = {
  needed: endsWorkWithJob(),
  powershell: async (script) => {
    // Encoded, so nothing in the script is read by a command line's quoting, and no execution policy applies
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const exe = systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'])
    const { stdout } = await run(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30_000, windowsHide: true })
    return stdout
  },
}

/** Puts process `pid` (this host) into a new job that ends its processes when the host ends. Never throws */
export async function joinWorkJob(pid: number = process.pid, os: WorkJobOs = REAL_OS): Promise<WorkJob> {
  if (!os.needed) return { state: 'not needed' }
  try {
    const said = (await os.powershell(JOIN_SCRIPT(pid, WORK_JOB_LIMITS))).trim()
    return said === 'ok' ? { state: 'joined' } : { state: 'failed', reason: said || 'no answer' }
  } catch (e) {
    // PowerShell missing or refusing (Add-Type is off under Constrained Language Mode), or past its time
    const err = e as { stderr?: string; message?: string }
    return { state: 'failed', reason: (err.stderr?.trim() || err.message || String(e)).split('\n')[0]!.slice(0, 300) }
  }
}

/** The log line for `job`; nothing where no job is needed */
export function workJobLine(job: WorkJob): string | null {
  if (job.state === 'joined') return "[agent-host] work processes end with this host (a Windows job object)"
  if (job.state === 'failed') return `[agent-host] could not tie work processes to this host (a Windows job object): ${job.reason}. What they start may outlive it`
  return null
}
