import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { endsWorkWithJob, systemTool } from '../os.js'
import { alive, settle } from '../dev-services/process-tree.test-helpers.js'
import { WORK_JOB_LIMITS, joinWorkJob, workJobLine } from './work-job.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/*
 * #1067 (#840 item 7, option b): on Windows the host joins a job object that ends what it started when it ends.
 */
describe('joining the work job', () => {
  const os = (answer: (script: string) => Promise<string>, needed = true) => ({ needed, powershell: answer })

  it('is not asked for where process groups end a tree', async () => {
    let asked = false
    const job = await joinWorkJob(1234, os(async () => ((asked = true), 'ok'), false))
    expect(job).toEqual({ state: 'not needed' })
    expect(asked).toBe(false)
    expect(workJobLine(job)).toBeNull()
  })

  it('asks for a job that ends its processes when closed, with no breakaway, for the pid given', async () => {
    let script = ''
    const job = await joinWorkJob(4321, os(async (s) => ((script = s), 'ok\r\n')))
    expect(job).toEqual({ state: 'joined' })
    // KILL_ON_JOB_CLOSE; not BREAKAWAY_OK (0x800), which let what Git Bash started leave the job
    expect(WORK_JOB_LIMITS).toBe(0x2000)
    expect(script).toContain(`Join(4321, ${WORK_JOB_LIMITS})`)
    // The copy in the host is not inheritable: a child holding it would keep the job, and its processes, alive
    expect(script).toMatch(/DuplicateHandle\(GetCurrentProcess\(\), job, host, out copy, 0, false, 2\)/)
    expect(workJobLine(job)).toContain('end with this host')
  })

  it('says why when Windows refused, or PowerShell could not run, and never throws', async () => {
    expect(await joinWorkJob(1, os(async () => 'assign 5'))).toEqual({ state: 'failed', reason: 'assign 5' })
    const refused = await joinWorkJob(1, os(async () => Promise.reject(Object.assign(new Error('Command failed'), { stderr: 'Add-Type : Cannot add type.\r\nmore' }))))
    expect(refused).toEqual({ state: 'failed', reason: 'Add-Type : Cannot add type.\r' })
    expect(workJobLine(refused)).toContain('may outlive it')
  })
})

/*
 * The real thing, on Windows: a stand-in host starts work the host's ways (`spawnGrouped`, a pty), each of which starts
 * a process through PowerShell's Start-Process, a program that is not Node. Ending the stand-in alone (`taskkill /F`
 * of its pid, no tree: a crash) must end them. Without the job both outlive it (measured on Windows 11: libuv's own job
 * lets a child's children leave, and ConPTY's are in no job).
 */
describe.runIf(endsWorkWithJob())('the work job on Windows (#1067)', () => {
  const HELPER = fileURLToPath(new URL('./work-job.test-helpers.ts', import.meta.url))
  const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
  let dir = ''
  let host: ChildProcess | undefined
  const grandchildren: number[] = []
  afterEach(() => {
    if (host?.pid && alive(host.pid)) host.kill()
    // Only what this test started, should it fail
    for (const pid of grandchildren.splice(0)) if (alive(pid)) process.kill(pid)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('ends what the host started, and what that started, when the host is killed', { timeout: 60_000 * SLOW }, async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-work-job-')))
    host = spawn(process.execPath, ['--import', 'tsx', HELPER, dir, 'join'], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
    const pid = (name: string) => (existsSync(join(dir, `${name}.pid`)) ? Number(readFileSync(join(dir, `${name}.pid`), 'utf8')) : 0)
    expect(await settle(() => pid('grouped') > 0 && pid('gitsh') > 0 && pid('pty') > 0, Boolean, 30_000 * SLOW)).toBe(true)
    grandchildren.push(pid('grouped'), pid('gitsh'), pid('pty'))
    expect(JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'))).toEqual({ state: 'joined' })
    expect(grandchildren.every(alive)).toBe(true)

    execFileSync(systemTool(['taskkill.exe']), ['/PID', String(host.pid), '/F'], { stdio: 'ignore', windowsHide: true })
    expect(await settle(() => grandchildren.filter(alive), (left) => left.length === 0, 10_000 * SLOW)).toEqual([])
  })
})
