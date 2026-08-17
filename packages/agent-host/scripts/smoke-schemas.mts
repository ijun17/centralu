/**
 * 결과 스키마 50개가 **실제 host 응답과 맞는가**.
 *
 * `commands.ts`의 result 스키마는 지금까지 런타임에서 한 번도 쓰이지 않았다 —
 * 문서일 뿐 보증이 아니었다. 검증을 켜기 전에 먼저 대조한다:
 * 틀린 스키마가 하나라도 있으면, 검증을 켜는 순간 멀쩡하던 기능이 죽는다.
 *
 * 실행: pnpm smoke:schemas
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { RpcMethods, type RpcMethodName } from '@cc/protocol'

const TOKEN = 'schema-token'
const cwd = mkdtempSync(join(tmpdir(), 'cc-schema-'))
// git 조회를 실제로 태우려면 저장소여야 한다
execSync('git init -q && git commit -q --allow-empty -m init', { cwd })
writeFileSync(join(cwd, 'a.txt'), 'hello\n')

const host = spawn(
  'node',
  ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--memory'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)

const port: number = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('host 기동 타임아웃')), 20000)
  host.stdout!.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        if (j.ready) {
          clearTimeout(t)
          resolve(j.port)
        }
      } catch {
        /* 로그 라인 무시 */
      }
    }
  })
})

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
let nextId = 1
const pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>()

ws.on('message', (raw: unknown) => {
  const f = JSON.parse(String(raw))
  if (f.kind === 'res') {
    const p = pending.get(f.id)
    if (p) {
      pending.delete(f.id)
      if (f.ok) p.res(f.result)
      else p.rej(new Error(f.error?.message ?? 'rpc error'))
    }
  }
})

const rpc = (method: string, params: unknown): Promise<unknown> => {
  const id = String(nextId++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(method + ' 타임아웃'))), 30000)
  })
}

await new Promise<void>((r) => ws.on('open', () => r()))
ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
await new Promise((r) => setTimeout(r, 300))

// ── 대조에 필요한 것들을 먼저 만든다 ────────────────────────────────
const project = (await rpc('projects.add', { path: cwd })) as { id: string }
const session = (await rpc('agents.createSession', {
  projectId: project.id,
  cwd,
  tool: 'claude',
  permissionPreset: 'normal',
})) as { id: string }
const term = (await rpc('terminal.create', { projectId: project.id, cols: 80, rows: 24 })) as { terminalId: string }

const P = project.id
const S = session.id
const T = term.terminalId

/** 메서드마다 무엇을 보낼지. null이면 "이번 대조에서는 부를 수 없음" + 이유 */
const CASES: Partial<Record<RpcMethodName, unknown>> & Record<string, unknown> = {
  'projects.list': {},
  'projects.add': { path: cwd },
  'projects.reorder': { orderedIds: [P] },
  'projects.gitStatus': { projectId: P },
  'sessions.list': {},
  'sessions.reorder': { projectId: P, orderedIds: [S] },
  'messages.load': { sessionId: S, limit: 10 },
  'agents.detect': {},
  'agents.capabilities': { tool: 'claude' },
  'agents.models': { tool: 'claude' },
  'agents.usage': { tool: 'claude' },
  'agents.commands': { sessionId: S },
  'agents.listExternalSessions': { projectId: P, tool: 'claude', limit: 3 },
  'agents.updateSettings': { sessionId: S, model: null, effort: null, permissionPreset: 'normal' },
  'sessions.rename': { sessionId: S, name: '대조용' },
  'sessions.markRead': { sessionId: S, seq: 0 },
  'agents.interrupt': { sessionId: S },
  'agents.archiveSession': { sessionId: S, archived: false },
  'agents.resumeSession': { sessionId: S },
  'controlCenter.get': {},
  'controlCenter.set': { sessionIds: [S] },
  'workspace.save': { layout: { focusedSessionId: S } },
  'workspace.load': {},
  'approvals.rules': {},
  'files.search': { projectId: P, query: 'a' },
  'fs.listDir': { projectId: P, path: '' },
  'fs.readFile': { projectId: P, path: 'a.txt' },
  'git.status': { projectId: P },
  'git.log': { projectId: P, limit: 5 },
  'git.branches': { projectId: P },
  'git.diff': { projectId: P, path: 'a.txt' },
  'git.stage': { projectId: P, paths: ['a.txt'] },
  'messages.search': { query: 'x', limit: 5 },
  'terminal.list': { projectId: P },
  'terminal.input': { terminalId: T, data: '\n' },
  'terminal.resize': { terminalId: T, cols: 80, rows: 24 },
  'terminal.restart': { terminalId: T, cols: 80, rows: 24 },
  'agents.createSession': { projectId: P, cwd, tool: 'claude', permissionPreset: 'normal' },
  // 버릴 임시 저장소다 — 실제로 커밋하고 체크아웃해도 잃을 것이 없다
  'git.commit': { projectId: P, message: '대조용 커밋' },
  'git.checkout': { projectId: P, branch: 'main', dryRun: true },
  // 원격이 없으니 실패한다. **그 실패 응답이 스키마와 맞는지**가 궁금한 것이다
  'git.push': { projectId: P },
  'attachments.save': { sessionId: S, name: 'a.txt', mime: 'text/plain', dataBase64: 'aGk=' },
  'approvals.deleteRule': { id: 999999 },
  // 보내기만 하고 응답 형태만 본다 (턴 완주는 smoke.mjs가 한다)
  'agents.send': { sessionId: S, text: 'hi' },
}

/** 부를 수 없는 것과 그 이유 — 조용히 빼면 "다 봤다"로 읽힌다 */
const SKIP: Record<string, string> = {
  'agents.respondApproval': '승인 요청이 떠 있어야 함 (smoke.mjs가 관통)',
  'agents.restartSession': '프로세스를 실제로 갈아 끼움 — 뒤 대조를 흔든다',
  'agents.deleteSession': '파괴적 — 맨 끝에서 따로 부른다',
  'git.commitDetail': '커밋 sha가 필요 — git.log 결과로 채운다',
  'terminal.create': '위에서 이미 불러 대조함',
  'terminal.close': '맨 끝에서 따로 부른다',
  'commands.run': '슬래시 명령 실행 — 부작용',
}

const ok: string[] = []
const bad: { m: string; issues: string }[] = []
const failed: { m: string; why: string }[] = []

// git.commitDetail은 sha를 얻어서 채운다
try {
  const log = (await rpc('git.log', { projectId: P, limit: 1 })) as { sha: string }[]
  if (log[0]?.sha) {
    CASES['git.commitDetail'] = { projectId: P, sha: log[0].sha }
    delete SKIP['git.commitDetail']
  }
} catch {
  /* 그대로 skip */
}

for (const m of Object.keys(RpcMethods) as RpcMethodName[]) {
  if (m in SKIP) continue
  if (!(m in CASES)) {
    failed.push({ m, why: '대조 케이스 없음 (이 스크립트의 구멍)' })
    continue
  }
  try {
    const result = await rpc(m, CASES[m])
    const parsed = RpcMethods[m].result.safeParse(result)
    if (parsed.success) ok.push(m)
    else bad.push({ m, issues: JSON.stringify(parsed.error.issues.slice(0, 3)) })
  } catch (e) {
    failed.push({ m, why: (e as Error).message })
  }
}

// 파괴적인 것들은 맨 끝에
for (const [m, params] of [
  ['terminal.close', { terminalId: T }],
  ['agents.deleteSession', { sessionId: S }],
] as const) {
  try {
    const parsed = RpcMethods[m as RpcMethodName].result.safeParse(await rpc(m, params))
    if (parsed.success) ok.push(m)
    else bad.push({ m, issues: JSON.stringify(parsed.error.issues.slice(0, 3)) })
  } catch (e) {
    failed.push({ m, why: (e as Error).message })
  }
  delete SKIP[m]
}

const total = Object.keys(RpcMethods).length
console.log(`\n대조 결과 (전체 ${total}개)`)
console.log(`  스키마 일치      ${ok.length}`)
console.log(`  스키마 불일치    ${bad.length}`)
console.log(`  호출 실패        ${failed.length}`)
console.log(`  대조 못 함       ${Object.keys(SKIP).length}`)

if (bad.length) {
  console.log('\n── 불일치 (검증을 켜면 여기서 죽는다) ──')
  for (const b of bad) console.log(`  ${b.m}\n     ${b.issues}`)
}
if (failed.length) {
  console.log('\n── 호출 실패 ──')
  for (const f of failed) console.log(`  ${f.m}: ${f.why}`)
}
console.log('\n── 대조하지 못한 것과 이유 ──')
for (const [m, why] of Object.entries(SKIP)) console.log(`  ${m}: ${why}`)

ws.close()
host.kill()
process.exit(bad.length ? 1 : 0)
