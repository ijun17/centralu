#!/usr/bin/env node
// Runs a program for at most <ms> milliseconds and, at the limit, ends it with everything it started (vitest's workers,
// tsc's children). A plain kill of the program leaves those running. Exits 124 at the limit, else with the program's code.
// Usage: node scripts/run-limited.mjs <ms> <program> [args...]
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const [ms, file, ...args] = process.argv.slice(2)
// Detached it leads a process group of its own (POSIX), which one signal ends whole; Windows has taskkill /T
const child = spawn(file, args, { stdio: 'inherit', detached: process.platform !== 'win32' })
let limited = false
const timer = setTimeout(() => {
  limited = true
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'taskkill.exe')
    spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'))
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}, Math.min(2_147_483_647, Number(ms)))
child.once('error', () => process.exit(127))
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exit(limited ? 124 : (code ?? 1))
})
