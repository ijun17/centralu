import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { endsWorkWithJob, systemTool } from '../os.js'

/**
 * **The host's work ends with it on Windows** (#1067, #840 item 7, owner's option b).
 *
 * Windows does not end a process's children when it ends. Node (libuv) puts each child it starts into a job of its own
 * with `KILL_ON_JOB_CLOSE`, so a direct child ends with the host, but that job also lets a child's own children leave it
 * silently (`SILENT_BREAKAWAY_OK`), and what a ConPTY starts leaves it the same way. So whatever an agent CLI, a Run
 * command, a git hook or an app server started through a program that is not Node (codex's MCP servers, a dev server
 * PowerShell started, `start`) kept running after the host crashed or was ended, holding its ports and memory
 * (measured on Windows 11: every such grandchild survived `taskkill /F` of the host, and was in no job).
 *
 * At start the host puts **itself** into a new job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway, and
 * holds the only handle to it, not inheritable. Every process it starts from then on, and everything those start, is
 * created in it, in all five ways the host starts one. Two things then end them with the host (both measured):
 *
 * 1. **No process can leave any more.** The job allows no breakaway, so libuv's silent breakaway no longer lets a
 *    child's children out of libuv's job, and that job (`KILL_ON_JOB_CLOSE`) ends them when the host does. A Node
 *    process is itself in a job once it has started a child (measured: in none before its first spawn, in one after);
 *    with this job held open by another process, so that it could not close, everything still ended.
 * 2. **This job's own `KILL_ON_JOB_CLOSE`**, when the host's handle closes. It does not depend on how libuv sets up
 *    its jobs, which is libuv's to change; `work-job.test.ts` reads the flag back from the job the host holds.
 *
 * The host itself rather than each child: a child added by its pid after the spawn could already have started its own
 * (cmd.exe runs its command at once), while a child of a process in a job is in it from its creation.
 *
 * - **Terminals are not in it.** What a person starts in a Centralu terminal is theirs, not the host's work: it must
 *   outlive a host that crashes (the owner's decision on #840 item 7), as it does today. Terminals are started by a
 *   broker the host starts **before** it joins (`dev-services/broker-pty.ts`), which is in no job of the host's. Run
 *   commands are the host's work and stay in the job.
 * - **What the host opens for the person** is not in it either: "Open in IDE" and `system.openUrl` are opened by the
 *   window, outside the host's tree.
 * - **No breakaway** (`JOB_OBJECT_LIMIT_BREAKAWAY_OK` is not set): only a process that asks to break away could leave,
 *   and Git for Windows' sh (MSYS) asks. With it allowed, what a git hook started, or anything under Git Bash (Claude
 *   Code's Bash tool on Windows), outlived the host (measured with the real host; without it, it ended, and the hook ran
 *   as before).
 * - **Under a keeper** the host does not join one: the keeper holds the agents, terminals and commands so that they
 *   outlive a host swap, and a job of the host's would end them with it. Windows has no keeper yet
 *   (docs/plans/runtime-unification.md step 9); there, an update is a quit and a new start, and the host ends its
 *   terminals, commands and agents on the way out with or without the job (measured).
 * - **A host swap or restart:** the next host is started by the window, not by this host, so it is in no job of this
 *   one's.
 * - **Already in a job** (a Node launcher's under `pnpm dev`, a CI runner's): the new job nests inside it (measured
 *   under a Node parent). Where Windows refuses (an outer job that forbids it), the host goes on as before and says so
 *   in its log.
 *
 * Node has no Job Object API. One PowerShell (~0.3–0.8 s on Windows 11, almost all of it PowerShell starting) creates
 * the job, puts the host in it, copies the handle into the host and exits. It runs while the host opens its store, and
 * the host waits for it before it starts anything (`START_ORDER`'s `work job`). A native addon would be a build step
 * per architecture for one call; the window (Rust) could create it, but `pnpm dev`, e2e and a Windows remote's
 * `serve` start the host without the window.
 */

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` alone (no breakaway, see the file header) */
export const WORK_JOB_LIMITS = 0x2000

/**
 * Creates the job, sets its limits, copies the handle into the process (not inheritable: a child holding it would
 * keep the job, and its processes, alive past the host), puts the process in the job and closes its own handles.
 * Prints `ok <handle>` (the handle's number in the process, for a test to read the job back), or the step that failed
 * and Windows' error number.
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
        return "ok " + copy.ToInt64();
      } finally { CloseHandle(host); }
    } finally { CloseHandle(job); }
  }
}
'@
[CentraluWorkJob]::Join(${pid}, ${limits})
`

/** What joining the job came to */
export type WorkJob = { state: 'joined'; handle: number } | { state: 'not needed' } | { state: 'failed'; reason: string }

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

/**
 * Puts process `pid` (this host) into a new job that ends its processes when the host ends. Not under a keeper (see the
 * file header). Never throws
 */
export async function joinWorkJob(place: { underKeeper: boolean }, pid: number = process.pid, os: WorkJobOs = REAL_OS): Promise<WorkJob> {
  if (!workJobWanted(place, os)) return { state: 'not needed' }
  try {
    const said = (await os.powershell(JOIN_SCRIPT(pid, WORK_JOB_LIMITS))).trim()
    const joined = /^ok (\d+)$/.exec(said)
    return joined ? { state: 'joined', handle: Number(joined[1]) } : { state: 'failed', reason: said || 'no answer' }
  } catch (e) {
    // PowerShell missing or refusing (Add-Type is off under Constrained Language Mode), or past its time
    const err = e as { stderr?: string; message?: string }
    return { state: 'failed', reason: (err.stderr?.trim() || err.message || String(e)).split('\n')[0]!.slice(0, 300) }
  }
}

/** Whether this host joins a work job, and so starts its terminals through the broker: on Windows, without a keeper */
export function workJobWanted(place: { underKeeper: boolean }, os: Pick<WorkJobOs, 'needed'> = REAL_OS): boolean {
  return os.needed && !place.underKeeper
}

/** The log line for `job`; nothing where no job is needed */
export function workJobLine(job: WorkJob): string | null {
  if (job.state === 'joined') return '[agent-host] work processes end with this host (a Windows job object); terminals are outside it'
  if (job.state === 'failed') return `[agent-host] could not tie work processes to this host (a Windows job object): ${job.reason}. What they start may outlive it`
  return null
}
