import { endsWorkWithJob, powershell } from '../os.js'
import { execText } from '../os/exec.js'

/**
 * **The host's work ends with it on Windows.** Windows does not end a process's children with it, and libuv's own job lets a
 * child's children leave it silently (`SILENT_BREAKAWAY_OK`), as a ConPTY's do, so what an agent CLI, a Run command, a git hook
 * or an app server started through a non-Node program outlived a host that crashed. At start the host puts **itself** into a
 * new job with `KILL_ON_JOB_CLOSE` and no breakaway, holding the only handle (not inheritable): everything it starts is created
 * in it, libuv's job still ends what cannot leave it, and the job's own flag ends the rest (`work-job.test.ts` reads it back).
 * The host itself, not each child by pid: a child added after the spawn may already have started its own. No breakaway because
 * Git for Windows' sh asks for it: its fork leaves a hook's `sleep` with an exited parent that no tree kill or sweep finds. Not
 * in it: terminals, started by a broker the host starts **before** it joins (`dev-services/broker-pty.ts`). Node has no Job
 * Object API: one PowerShell (0.3–0.8 s) does it while the store opens, and the host waits for it before it starts anything
 * (`START_ORDER` `work job`). More: docs/agent-host/host-process.md.
 */

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` alone (no breakaway, see the file header) */
export const WORK_JOB_LIMITS = 0x2000

/**
 * Creates the job, sets its limits, copies the handle into the process (not inheritable: a child holding it would keep the job
 * alive past the host), joins the process and closes its own handles. Prints `ok <handle>` (the handle's number, for a test to
 * read the job back), or the failed step and Windows' error number
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

const REAL_OS: WorkJobOs = {
  needed: endsWorkWithJob(),
  powershell: async (script) => {
    // Encoded, so nothing in the script is read by a command line's quoting, and no execution policy applies
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await execText(powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs: 30_000 })
    return stdout
  },
}

/**
 * Puts process `pid` (this host) into a new job that ends its processes when the host ends. Never throws. Node has no Job
 * Object API, and a native addon is a build step per architecture for one call, and the window cannot create the job either:
 * `pnpm dev`, e2e and `serve` start the host without one. A host already in a job (a launcher's under `pnpm dev`, a CI
 * runner's) nests this one inside it (measured under a Node parent); where Windows refuses, it goes on and says so in its log.
 * The next host of a swap is started by the window, so it is in no job of this one's. A job per run would cost one PowerShell
 * (0.3–0.8 s) per program started, so a run is not put in one
 */
export async function joinWorkJob(pid: number = process.pid, os: WorkJobOs = REAL_OS): Promise<WorkJob> {
  if (!workJobWanted(os)) return { state: 'not needed' }
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

/** Whether this host joins a work job, and so starts its terminals through the broker: on Windows, keeper or not */
export function workJobWanted(os: Pick<WorkJobOs, 'needed'> = REAL_OS): boolean {
  return os.needed
}

/** The log line for `job`; nothing where no job is needed */
export function workJobLine(job: WorkJob): string | null {
  if (job.state === 'joined') return '[agent-host] work processes end with this host (a Windows job object); terminals are outside it'
  if (job.state === 'failed') return `[agent-host] could not tie work processes to this host (a Windows job object): ${job.reason}. What they start may outlive it`
  return null
}
