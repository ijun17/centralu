/**
 * L3 스모크: 진짜 PTY로 터미널을 관통 검증한다.
 * 유닛 테스트는 node-pty를 가짜로 갈아 끼우므로 **실제 셸이 뜨는지는 여기서만 알 수 있다**
 * (spawn-helper 실행 권한이 빠져 `posix_spawnp failed`가 났던 전례가 있다).
 *
 * 실행: npx tsx packages/agent-host/scripts/smoke-terminal.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService } from '../src/dev-services/terminal.js'

const cwd = mkdtempSync(join(tmpdir(), 'cc-term-smoke-'))
writeFileSync(join(cwd, 'MARKER.txt'), 'x')

const svc = new TerminalService(() => {})
const h = svc.attach(cwd, 80, 24)
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

// 같은 디렉토리에 다시 붙으면 같은 터미널 + 기록 유지
const again = svc.attach(cwd, 80, 24)
const sameId = again.id === h.id
const keptHistory = again.history().includes('MARKER.txt')

// 다른 디렉토리는 자기 터미널 (워크트리 대비)
const other = mkdtempSync(join(tmpdir(), 'cc-term-other-'))
const b = svc.attach(other, 80, 24)

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
