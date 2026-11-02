#!/usr/bin/env node
// Runs a program for at most <ms> milliseconds and, at the limit, ends it with everything it started (vitest's workers,
// tsc's children). A plain kill of the program leaves those running. Exits 124 at the limit, else with the program's code.
// Usage: node scripts/run-limited.mjs <ms> <program> [args...]
//
// The program stays in this process's group (not detached), so whoever ends pre-pr's group (the board cancelling it) ends the
// program and its workers too; at the limit the descendants are found and ended one by one instead.
import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { join } from 'node:path'

const [ms, file, ...args] = process.argv.slice(2)
const child = spawn(file, args, { stdio: 'inherit' })

/** Every process below `pid` (POSIX: from the process table) */
function descendants(pid) {
  const children = new Map()
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number)
    if (p) children.set(pp, [...(children.get(pp) ?? []), p])
  }
  const walk = (p) => (children.get(p) ?? []).flatMap((c) => [c, ...walk(c)])
  return walk(pid)
}

let limited = false
const timer = setTimeout(() => {
  limited = true
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'))
    return
  }
  // The program first, so it starts no new worker while the ones it had are ended; then what the snapshot (taken before) found
  let found = []
  try {
    found = descendants(child.pid)
  } catch {
    // no ps: the program alone
  }
  for (const pid of [child.pid, ...found]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone already
    }
  }
}, Math.min(2_147_483_647, Number(ms)))
child.once('error', () => process.exit(127))
child.once('exit', (code, signal) => {
  clearTimeout(timer)
  process.exit(limited ? 124 : (code ?? 128 + (constants.signals[signal] ?? 0)))
})
