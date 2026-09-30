/**
 * L3 smoke test: verifies the terminal end-to-end with a real PTY.
 * The unit tests swap in a fake node-pty, so **whether a real shell actually comes up can only be
 * known here** (there is precedent: `posix_spawnp failed` happened once because spawn-helper's
 * execute permission was missing).
 *
 * Run with: npx tsx packages/agent-host/scripts/smoke-terminal.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService } from '../src/dev-services/terminal.js'

const cwd = mkdtempSync(join(tmpdir(), 'cc-term-smoke-'))
writeFileSync(join(cwd, 'MARKER.txt'), 'x')

const svc = new TerminalService(() => {})
// attach(cwd) was split into list/create (several terminals per directory).
// "reattaching" now means finding the existing one with list() — this verifies that meaning as is.
const h = svc.create(cwd, 80, 24)
console.log(`터미널 생성: ${h.id} · alive=${h.alive}`)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
await wait(900)
svc.input(h.id, 'ls\n')
await wait(1200)
svc.input(h.id, 'pwd\n')
await wait(1200)

const out = h.history()
const sawMarker = out.includes('MARKER.txt')
const sawCwd = out.includes(cwd.replace('/private', '')) || out.includes(cwd)

// Reattaching to the same directory keeps the same terminal + scrollback
const again = svc.list(cwd)[0]
const sameId = again?.id === h.id
const keptHistory = again?.history().includes('MARKER.txt') ?? false

// A different directory gets its own terminal (accounting for worktrees)
const other = mkdtempSync(join(tmpdir(), 'cc-term-other-'))
const b = svc.create(other, 80, 24)

console.log('\n판정:')
console.log('  셸이 실제로 떴는가:', h.alive ? 'O' : 'X')
console.log('  명령이 실행됐는가 (ls):', sawMarker ? 'O' : 'X')
console.log('  cwd가 맞는가 (pwd):', sawCwd ? 'O' : 'X')
console.log('  다시 붙으면 같은 터미널:', sameId ? 'O' : 'X')
console.log('  기록이 남는가:', keptHistory ? 'O' : 'X')
console.log('  다른 디렉토리는 다른 터미널:', b.id !== h.id ? 'O' : 'X')

svc.disposeAll()
rmSync(cwd, { recursive: true, force: true })
rmSync(other, { recursive: true, force: true })
process.exit(sawMarker && h.alive && sameId ? 0 : 1)
