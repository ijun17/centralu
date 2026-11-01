import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { endsWorkWithJob, systemTool } from '../os.js'
import { settle } from '../dev-services/process-tree.test-helpers.js'
import { fileHolding, ownProcesses } from '../process.test-helpers.js'
import { WORK_JOB_LIMITS, joinWorkJob, workJobLine, workJobWanted } from './work-job.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/*
 * #1067 (#840 item 7, option b): on Windows the host joins a job object that ends what it started when it ends.
 */
describe('joining the work job', () => {
  const os = (answer: (script: string) => Promise<string>, needed = true) => ({ needed, powershell: answer })
  const free = { underKeeper: false }

  it('is not asked for where process groups end a tree', async () => {
    let asked = false
    const job = await joinWorkJob(free, 1234, os(async () => ((asked = true), 'ok 1'), false))
    expect(job).toEqual({ state: 'not needed' })
    expect(asked).toBe(false)
    expect(workJobLine(job)).toBeNull()
  })

  it('is not joined under a keeper, which holds the children a job of the host would end with it', async () => {
    let asked = false
    expect(await joinWorkJob({ underKeeper: true }, 1234, os(async () => ((asked = true), 'ok 1')))).toEqual({ state: 'not needed' })
    expect(asked).toBe(false)
    expect(workJobWanted({ underKeeper: true }, { needed: true })).toBe(false)
    expect(workJobWanted(free, { needed: true })).toBe(true)
  })

  it('asks for a job that ends its processes when closed, with no breakaway, for the pid given', async () => {
    let script = ''
    const job = await joinWorkJob(free, 4321, os(async (s) => ((script = s), 'ok 720\r\n')))
    expect(job).toEqual({ state: 'joined', handle: 720 })
    // KILL_ON_JOB_CLOSE; not BREAKAWAY_OK (0x800), which let what Git Bash started leave the job
    expect(WORK_JOB_LIMITS).toBe(0x2000)
    expect(script).toContain(`Join(4321, ${WORK_JOB_LIMITS})`)
    // The copy in the host is not inheritable: a child holding it would keep the job, and its processes, alive
    expect(script).toMatch(/DuplicateHandle\(GetCurrentProcess\(\), job, host, out copy, 0, false, 2\)/)
    expect(workJobLine(job)).toContain('end with this host')
  })

  it('says why when Windows refused, or PowerShell could not run, and never throws', async () => {
    expect(await joinWorkJob(free, 1, os(async () => 'assign 5'))).toEqual({ state: 'failed', reason: 'assign 5' })
    const refused = await joinWorkJob(free, 1, os(async () => Promise.reject(Object.assign(new Error('Command failed'), { stderr: 'Add-Type : Cannot add type.\r\nmore' }))))
    expect(refused).toEqual({ state: 'failed', reason: 'Add-Type : Cannot add type.\r' })
    expect(workJobLine(refused)).toContain('may outlive it')
  })
})

/**
 * Reads back, from outside, the job a process holds a handle to: copies the handle out of it and asks the job for its
 * limits, and whether the process is in it. Answers `<limit flags> <in it>`.
 */
const READ_JOB = (pid: number, handle: number) => `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ReadJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr fromProcess, IntPtr handle, IntPtr toProcess, out IntPtr copy, int access, bool inherit, int options);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Extended info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  public static string Read(int pid, long handle) {
    IntPtr owner = OpenProcess(0x0040 | 0x1000, false, pid);
    IntPtr job;
    if (!DuplicateHandle(owner, new IntPtr(handle), GetCurrentProcess(), out job, 0, false, 2)) return "copy " + Marshal.GetLastWin32Error();
    Extended info;
    if (!QueryInformationJobObject(job, 9, out info, Marshal.SizeOf(typeof(Extended)), IntPtr.Zero)) return "query " + Marshal.GetLastWin32Error();
    bool inIt;
    IsProcessInJob(owner, job, out inIt);
    return info.BasicLimitInformation.LimitFlags + " " + inIt;
  }
}
'@
[ReadJob]::Read(${pid}, ${handle})
`

/*
 * The real thing, on Windows: a stand-in host, in the real host's order, starts work the host's ways, each of which
 * starts a process through PowerShell's Start-Process (a program that is not Node). Without the job those outlived it
 * (measured on Windows 11). What a terminal started must outlive it: the terminal broker was started before the job.
 */
describe.runIf(endsWorkWithJob())('the work job on Windows (#1067)', () => {
  const HELPER = fileURLToPath(new URL('./work-job.test-helpers.ts', import.meta.url))
  const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
  const WORK = ['grouped', 'gitsh', 'command']
  let dir = ''
  let host: ChildProcess | undefined
  const started: number[] = []
  // What the test has seen end is not ended again afterwards: its number may be someone else's by then (#1308)
  let own = ownProcesses()
  const alive = (pid: number) => own.alive(pid)
  afterEach(async () => {
    // Before the host goes: closing its job ends the work too, and a number it frees must not be signalled after
    // Only what this test started and has not seen end, the terminal's grandchild above all (it is meant to stay)
    own.end(started.splice(0))
    // By its handle: Node sends nothing once the child has exited
    host?.kill()
    await new Promise((r) => setTimeout(r, 500))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  async function standIn(): Promise<{ pid: (name: string) => number; job: { state: string; handle?: number; broker?: number } }> {
    own = ownProcesses()
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-work-job-')))
    host = spawn(process.execPath, ['--import', 'tsx', HELPER, dir, 'join'], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
    const pid = (name: string) => (existsSync(join(dir, `${name}.pid`)) ? Number(readFileSync(join(dir, `${name}.pid`), 'utf8')) : 0)
    const names = [...WORK, 'terminal']
    const up = await settle(() => names.filter((n) => pid(n) > 0), (got) => got.length === names.length, 30_000 * SLOW)
    started.push(...up.map(pid))
    expect(up.sort()).toEqual([...names].sort())
    return { pid, job: await fileHolding(join(dir, 'job.json'), (t) => JSON.parse(t) as { state: string; handle?: number; broker?: number }) }
  }

  it('the job the host holds ends its processes when closed, allows no breakaway, and has the host in it', { timeout: 60_000 * SLOW }, async () => {
    const { job } = await standIn()
    expect(job.state).toBe('joined')
    const read = execFileSync(systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe']), ['-NoProfile', '-NonInteractive', '-Command', READ_JOB(host!.pid!, job.handle!)], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    const [flags, inIt] = read.split(' ')
    expect(inIt, read).toBe('True')
    // KILL_ON_JOB_CLOSE; neither BREAKAWAY_OK (0x800) nor SILENT_BREAKAWAY_OK (0x1000)
    expect(Number(flags) & 0x2000, read).toBe(0x2000)
    expect(Number(flags) & (0x800 | 0x1000), read).toBe(0)
  })

  it('a host killed takes its work with it, and leaves what a terminal started', { timeout: 60_000 * SLOW }, async () => {
    const { pid, job } = await standIn()
    expect(job.state).toBe('joined')
    const work = WORK.map(pid)
    expect([...work, pid('terminal')].every(alive)).toBe(true)

    execFileSync(systemTool(['taskkill.exe']), ['/PID', String(host!.pid), '/F'], { stdio: 'ignore', windowsHide: true })
    expect(await settle(() => work.filter(alive), (left) => left.length === 0, 10_000 * SLOW)).toEqual([])
    // The broker ends with the host, and its pseudoconsole with it; what the terminal started outside it stays
    expect(await settle(() => alive(job.broker!), (up) => !up, 10_000 * SLOW)).toBe(false)
    expect(alive(pid('terminal'))).toBe(true)
  })
})
