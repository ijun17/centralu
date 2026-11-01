// open_pr's mechanical checks (#1181): the repository's `pnpm pre-pr` (scripts/pre-pr.mjs), run on the
// pull request's commits before it opens. The board refuses with what it found; an exemption from one
// check, or `skipPrePr` for all of them, takes a reason, which goes into the description.
//
// The branches are fetched under refs of this call's own and removed again afterwards (as fetchRefs
// in git.mjs does): no branch or remote-tracking ref of the person's moves. The script works in
// temporary worktrees, so the checkout is not touched either. Cancelled or out of time, the script's
// whole process tree is stopped and its `--cleanup` removes what it left (worktrees, dependency links).
import { execFile, spawn } from './system.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git, remoteFor, topLevel } from './git.mjs'
import { now as clock } from './clock.mjs'

const SPACE = 'refs/centralu-pre-pr'
// A tier's name as it goes into a label; which names exist is the repository's (scripts/tier.mjs), not the board's
const TIER_NAME = /^[a-z][a-z-]{0,30}$/
/** The tier of a change nobody could judge (a script that answers none, or an unreadable one): deep, never lower */
export const UNKNOWN_TIER = { name: 'deep', line: 'Tier: deep (pnpm pre-pr answered no tier, so the paths were not judged).', because: [] }
// A stack of three builds three heads, then runs the changed tests twice: minutes, not seconds
const LIMIT_MS = 30 * 60_000
const BEAT_MS = 60_000
// The script divides its own time among its phases and answers by then (what it did not reach is said in its answer);
// the kill at `limitMs` is only for a script that does not. The clean-up of a killed run needs the difference
const scriptLimit = (limitMs) => Math.max(60, Math.floor(limitMs / 1000) - 120)
// Each call has a name of its own, for its refs and for the script's run folder: two open_pr calls run
// pre-pr side by side (outside the write line), and one's clean-up must not take what the other uses
let calls = 0

/** The last line of the script's stdout that is a JSON object: its answer. */
export function answerOf(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').reverse()
  for (const line of lines) {
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      // progress or a stray line: the answer is the last JSON line
    }
  }
  return null
}

/** Stops a process and everything it started: tsc, vitest and pnpm run under the script. */
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    if (process.platform === 'win32') execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], () => {})
    else {
      try {
        // Started detached, so it leads a process group of its own
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  })
}

/** Runs the script; answers { stdout, stderr, code, stopped } where `stopped` is 'cancelled' or 'timed out'. */
function runScript(args, cwd, { signal, limitMs, beat }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let stopped = null
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)))
    const started = clock()
    const timer = setInterval(() => beat(Math.round((clock() - started) / 1000)), BEAT_MS)
    const stop = (why) => {
      if (stopped) return
      stopped = why
      void stopTree(child)
    }
    const limit = setTimeout(() => stop('timed out'), limitMs)
    const onAbort = () => stop('cancelled')
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (e) => {
      stderr += String(e.message)
    })
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearInterval(timer)
      clearTimeout(limit)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, code, stopped })
    }
    child.once('close', finish)
    // On Windows a process the script left running keeps its output open, and 'close' never comes:
    // its own exit, and a moment for the last output, are enough
    child.once('exit', (code) => setTimeout(() => finish(code), 5_000).unref())
  })
}

/**
 * Runs the repository's pre-PR script in the checkout at `dir` on `head` (with `lowers`, the branches
 * of the pull requests under it, oldest first). Answers { ran: false, why, refsLeft } when it cannot
 * run here or was stopped, or { ran: true, ok, findings, warnings, exempted, notes, head, heads, tier,
 * refsLeft } from the script. `exempt` maps a check to the reason it is left out. `beat` is called
 * while it runs; `signal` cancels it.
 */
export async function runPrePr({ dir, repo, head, base, main, lowers = [], exempt = {}, script = 'scripts/pre-pr.mjs', beat = () => {}, signal, limitMs = LIMIT_MS }) {
  const root = await topLevel(dir)
  const path = join(root, script)
  if (!existsSync(path)) return { ran: false, why: `the checkout at ${root} has no ${script}`, refsLeft: [] }
  const remote = await remoteFor(root, repo)
  if (!remote) return { ran: false, why: `the checkout at ${root} has no remote for github.com/${repo}`, refsLeft: [] }
  const id = `board-${process.pid}-${++calls}`
  const branches = [...new Set([head, base, main, ...lowers])]
  const ref = (b) => `${SPACE}/${id}/${b}`
  const refsLeft = []
  try {
    await git(root, ['fetch', '--no-tags', '--quiet', remote, ...branches.map((b) => `+refs/heads/${b}:${ref(b)}`)], { timeoutMs: 5 * 60_000 })
    if (signal?.aborted) return { ran: false, why: 'the call was cancelled', refsLeft }
    const args = [path, '--json', '--no-fetch', '--run-id', id, '--remote', remote, '--limit', String(scriptLimit(limitMs)), '--head', ref(head), '--base', ref(base), '--main', ref(main), ...lowers.flatMap((b) => ['--stack', ref(b)])]
    for (const [check, why] of Object.entries(exempt)) args.push('--exempt', `${check}=${why}`)
    const result = await runScript(args, root, { signal, limitMs, beat })
    if (result.stopped) {
      // Killed, the script's own clean-up never ran: its run folder goes now, links first
      const cleanup = await runScript([path, '--cleanup', id], root, { limitMs: 5 * 60_000, beat: () => {} })
      const left = cleanup.code === 0 ? '' : ` Its clean-up said: ${cleanup.stderr.trim().split('\n').slice(-3).join(' ') || `exit ${cleanup.code}`}`
      return { ran: false, why: `it was stopped: ${result.stopped === 'timed out' ? `it did not finish within ${limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} minutes` : `${Math.round(limitMs / 1000)} s`}` : 'the call was cancelled'}.${left}`, refsLeft }
    }
    const a = answerOf(result.stdout)
    if (!a || a.error || !Array.isArray(a.findings)) {
      const why = a?.error ?? (result.stderr.trim().split('\n').slice(-5).join(' ') || 'it gave no answer')
      return { ran: false, why: `${script} could not check: ${why}`, refsLeft }
    }
    return {
      ran: true,
      ok: a.ok === true && a.findings.length === 0,
      findings: a.findings,
      warnings: a.warnings ?? [],
      exempted: a.exempted ?? [],
      notes: a.notes ?? [],
      head: a.head ?? null,
      heads: a.heads ?? [],
      // The risk tier (#1259): { name, line, because }; deep when the script answered none
      tier: TIER_NAME.test(a.tier?.name ?? '') && typeof a.tier.line === 'string' ? { name: a.tier.name, line: a.tier.line, because: Array.isArray(a.tier.because) ? a.tier.because : [] } : UNKNOWN_TIER,
      refsLeft,
    }
  } finally {
    // One after the other: each takes git's lock on the ref store (see fetchRefs). One left behind is said, not swallowed
    for (const b of branches) {
      await git(root, ['update-ref', '-d', ref(b)]).catch((e) => refsLeft.push(`${ref(b)} (${e.message}); remove it with git update-ref -d ${ref(b)}`))
    }
  }
}
