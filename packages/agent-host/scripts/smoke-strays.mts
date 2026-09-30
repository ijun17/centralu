/**
 * L3 smoke test: finding and stopping stray processes (requested by the user, 2026-09-07).
 *
 * The unit test (strays.test.ts) checks the **selection rule** as a value. Here, two real
 * processes are actually started to see **what ps and lsof really answer on this machine** — the
 * risk in this feature is not in the rule but in the tool output (measured: lsof answers with the
 * symlink-resolved path, so without resolving the root, the same folder goes unrecognized).
 *
 *   1. The shape an agent leaves behind — the intermediate shell exits, so ppid=1, no controlling
 *      terminal → **must be caught**
 *   2. Something a person started from a terminal — has a tty → **must not be caught**
 *
 * Run with: pnpm smoke:strays
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { findStrays, stopStrays } from '../src/dev-services/strays.js'
const require = createRequire(import.meta.url)
const pty = require('node-pty')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const root = mkdtempSync(join(tmpdir(), 'cc-stray-'))
const pidfile = join(root, 'pid')
// The intermediate shell exits immediately, so node gets adopted by init (the shape the agent's
// bash tool produces)
const sh = spawn('/bin/sh', ['-c', `node -e 'require("fs").writeFileSync("${pidfile}", String(process.pid));setInterval(()=>{},1e3)' &`], {
  cwd: root, stdio: 'ignore', detached: true,
})
sh.unref()
for (let i = 0; i < 20 && !existsSync(pidfile); i++) await sleep(300)
const orphanPid = Number(readFileSync(pidfile, 'utf8'))

const p = pty.spawn('/bin/zsh', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: root })
let buf = ''
p.onData((d: string) => (buf += d))
p.write(`node -e 'setInterval(()=>{},1e3)' & echo MINE=$!\n`)
await sleep(2500)
const mine = Number(/MINE=(\d+)/.exec(buf)?.[1])
console.log('고아 :', execSync(`ps -o pid=,ppid=,tty= -p ${orphanPid}`).toString().trim())
console.log('사람 :', execSync(`ps -o pid=,ppid=,tty= -p ${mine}`).toString().trim())

const found = await findStrays([root])
console.log('찾은 것:', found.map((s) => `${s.pid}`).join(',') || '(없음)')
console.log('고아 잡혔나:', found.some((s) => s.pid === orphanPid), '/ 사람 것 안 잡혔나:', !found.some((s) => s.pid === mine))

console.log('stopStrays:', await stopStrays([orphanPid], [root]))
await sleep(1200)
console.log('고아 죽었나:', !alive(orphanPid), '/ 사람 것 살아있나:', alive(mine))
const cleanup = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already dead — the point of cleaning up is achieved either way
  }
}
cleanup(mine)
cleanup(orphanPid)
p.kill()
rmSync(root, { recursive: true, force: true })
const ok = found.some((s) => s.pid === orphanPid) && !found.some((s) => s.pid === mine)
console.log(ok ? '[strays] OK' : '[strays] 실패 — 위 줄을 보세요')
process.exit(ok ? 0 : 1)
