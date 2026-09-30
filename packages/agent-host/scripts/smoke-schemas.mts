/**
 * Do the 50 result schemas **match the host's real responses?**
 *
 * The result schemas in `commands.ts` had never once run against the runtime — they were
 * documentation, not a guarantee. This checks them before validation is turned on: if even one
 * schema is wrong, turning validation on would kill a feature that used to work fine.
 *
 * Run with: pnpm smoke:schemas
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
// Has to be an actual repository to genuinely exercise a source-control lookup
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
        /* ignore log lines */
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

// ── First create what checking needs ────────────────────────────────
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

/** What to send for each method. null means "cannot be called for this check" + a reason */
const CASES: Partial<Record<RpcMethodName, unknown>> & Record<string, unknown> = {
  'projects.list': {},
  'projects.add': { path: cwd },
  'projects.reorder': { orderedIds: [P] },
  'projects.setCommands': { projectId: P, commands: ['echo 대조용'] },
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
  'agents.switchTool': { sessionId: S, tool: 'codex' },
  'agents.updateSettings': { sessionId: S, model: null, effort: null, permissionPreset: 'normal' },
  'sessions.rename': { sessionId: S, name: '대조용' },
  'sessions.markRead': { sessionId: S, seq: 0 },
  'agents.interrupt': { sessionId: S },
  'agents.archiveSession': { sessionId: S, archived: false },
  'agents.resumeSession': { sessionId: S },
  'orchestrator.get': {},
  'orchestrator.tools': {},
  'grid.get': {},
  'grid.set': { sessionIds: [S] },
  'workspace.save': { layout: { focusedSessionId: S } },
  'workspace.load': {},
  'approvals.rules': {},
  'trash.list': {},
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
  // A disposable temp repository — actually committing and checking out loses nothing
  'git.commit': { projectId: P, message: '대조용 커밋' },
  'git.checkout': { projectId: P, branch: 'main', dryRun: true },
  // Fails because there is no remote. **Whether that failure response matches the schema** is what is being checked
  'git.push': { projectId: P },
  'attachments.save': { sessionId: S, name: 'a.txt', mime: 'text/plain', dataBase64: 'aGk=' },
  'approvals.deleteRule': { id: 999999 },
  // Only sends it and checks the response shape (a full turn is covered by smoke.mjs)
  'agents.send': { sessionId: S, text: 'hi' },
  // Answers even for a nonexistent app — the building session is null, the error bundle is an empty list (M4 C-2, C-6)
  'apps.builder': { appId: 'no-such-app', projectId: P },
  'apps.errors': { appId: 'no-such-app', projectId: P },
  // A conversation that never opened a view — holds no view (M4 B-1)
  'apps.inlineViews': { sessionId: S },
  // Cancels a nonexistent import — passes through quietly (M4 E-3)
  'apps.importCancel': { token: 'no-such-import' },
  // A capability question and its remembered answer (M4 D-4) — nothing is being asked, and a nonexistent app has no remembered answer (an empty list). Forgetting something that does not exist is fine
  'apps.questions': {},
  'apps.permissions': { appId: 'no-such-app', projectId: P },
  'apps.forgetPermission': { appId: 'no-such-app', projectId: P, capability: 'agent:claude' },
  'apps.usage': { appId: 'no-such-app', projectId: P },
}

/** What cannot be called, and why — leaving it out silently would read as "everything was checked" */
const SKIP: Record<string, string> = {
  'agents.respondApproval': '승인 요청이 떠 있어야 함 (smoke.mjs가 관통)',
  'agents.answerQuestion': '질문 요청이 떠 있어야 함 (승인과 같은 이유)',
  'agents.forkConversation': '잠긴 codex 대화가 있어야 함 — 헤드리스로 만들 수 없다',
  'agents.restartSession': '프로세스를 실제로 갈아 끼움 — 뒤 대조를 흔든다',
  'agents.deleteSession': '파괴적 — 맨 끝에서 따로 부른다',
  // The trash (#204) needs a session in it — the end of the script puts one there and walks the ways out
  'trash.read': 'needs a session in the trash — called at the end',
  'trash.restore': 'needs a session in the trash — called at the end',
  'trash.purge': 'needs a session in the trash — called at the end',
  'trash.empty': 'deletes everything in the trash for good — called at the end',
  'git.commitDetail': '커밋 sha가 필요 — git.log 결과로 채운다',
  'terminal.create': '위에서 이미 불러 대조함',
  'terminal.close': '맨 끝에서 따로 부른다',
  'commands.run': '슬래시 명령 실행 — 부작용',
  'apps.sessionTools': 'Codex 다리 전용 — 외부 앱이 붙은 살아 있는 세션이 필요 (adapters/codex/apps.test.ts가 다리째 관통)',
  'apps.sessionCall': 'Codex 다리 전용 — apps.sessionTools와 같은 이유',
  'apps.remove': '파괴적 — 사용자 폴더 앱을 옮겨 버린다 (sessions/mcp-apps.test.ts가 관통)',
  'apps.openView': '신뢰한 프로젝트에 home이 있는 외부 앱이 필요 (app-home-view.test.ts가 진짜 앱으로 관통)',
  'apps.closeView': 'apps.openView가 연 인스턴스가 필요 — 같은 시험이 관통',
  'apps.create': '앱 폴더와 만드는 세션(진짜 에이전트)을 만든다 (sessions/create-app.test.ts·app-builder.test.ts가 관통)',
  'apps.createBuilder': '만드는 세션(진짜 에이전트)을 띄운다 — apps.create와 같은 이유',
  'apps.check': '앱을 실제로 띄운다 — 템플릿 앱이 필요 (apps/external/check.test.ts가 관통)',
  'apps.viewMessage': '세션이 부른 화면 달린 앱 도구의 열린 대화 안 화면이 필요 (inline-views.test.ts가 진짜 앱으로 관통)',
  'apps.inlineReopen': '접힌 대화 안 화면이 필요 — 같은 시험이 관통(상한과 다시 열기)',
  'apps.askBuilder': '앱의 만드는 세션(진짜 에이전트)에 말을 넣는다 (builder-requests.test.ts·platform.contract.test.ts가 관통)',
  'apps.sendError': '앱의 오류 묶음과 만드는 세션(진짜 에이전트)이 필요 — builder-requests.test.ts가 관통',
  'apps.answerQuestion': '화면에서 시작된 사슬의 능력 물음이 떠 있어야 함 (sessions/app-capabilities.test.ts가 진짜 앱으로 관통)',
  'apps.setSecret': '비밀을 선언한 앱이 필요 — 비밀 값을 이 기계에 쓴다 (app-secrets.test.ts가 진짜 앱으로 관통)',
  'apps.importPrepare': '가져올 폴더나 zip이 필요 — 데이터 폴더의 대기실에 쓴다 (apps/external/imports.test.ts·platform.contract.test.ts가 관통)',
  'apps.importCommit': '준비한 가져오기의 토큰이 필요 — 사용자 폴더에 앱을 들인다 (같은 시험이 관통)',
  'apps.review': '가져온 앱이 필요 (같은 시험이 관통)',
  'apps.enable': '가져온 앱과 그 확인 창의 열쇠가 필요 (같은 시험이 관통)',
  'apps.versions': '외부 앱이 필요 — 사용자 폴더 앱은 스냅샷, 프로젝트 앱은 git (app-versions.test.ts가 진짜 저장소로 관통)',
  'apps.restoreVersion': '떠 둔 판이 있는 사용자 폴더 앱이 필요 — 앱 폴더를 되쓴다 (apps/external/versions.test.ts가 관통)',
}

const ok: string[] = []
const bad: { m: string; issues: string }[] = []
const failed: { m: string; why: string }[] = []

// orchestrator.tool can only be called by the orchestrator itself — get its id first
try {
  const orc = (await rpc('orchestrator.get', {})) as { id: string }
  CASES['orchestrator.tool'] = { sessionId: orc.id, name: 'list_sessions', args: {} }
} catch {
  SKIP['orchestrator.tool'] = '오케스트레이터를 못 만듦'
}

// git.commitDetail fills in a sha once one is obtained
try {
  const log = (await rpc('git.log', { projectId: P, limit: 1 })) as { sha: string }[]
  if (log[0]?.sha) {
    CASES['git.commitDetail'] = { projectId: P, sha: log[0].sha }
    delete SKIP['git.commitDetail']
  }
} catch {
  /* leave it skipped */
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

// Destructive ones go at the very end
for (const [m, params] of [
  ['terminal.close', { terminalId: T }],
  ['agents.deleteSession', { sessionId: S }],
  ['trash.read', { sessionId: S }],
  ['trash.restore', { sessionId: S }],
  ['agents.deleteSession', { sessionId: S }],
  ['trash.purge', { sessionId: S }],
  ['trash.empty', {}],
] as const) {
  try {
    const parsed = RpcMethods[m as RpcMethodName].result.safeParse(await rpc(m, params))
    // agents.deleteSession runs twice (into the trash, and again after the restore) — count a method once
    if (!parsed.success) bad.push({ m, issues: JSON.stringify(parsed.error.issues.slice(0, 3)) })
    else if (!ok.includes(m)) ok.push(m)
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
// A call failure counts as a failure too — if the schema could not even be checked and this
// exits 0, CI reads it as "everything is fine." Neither a mismatch nor a call failure is left green.
process.exit(bad.length || failed.length ? 1 : 0)
