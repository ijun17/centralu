/* eslint-disable @typescript-eslint/no-explicit-any -- the smoke test reads the host's raw frames directly */
/**
 * #561 end to end: **does a real session start another agent in its own project, and read back the file it made?**
 *
 * One trusted scratch project, a host on a temp store and data folder (never `~/.centralu`). A Claude haiku session
 * (preset normal) is told to have another agent write a file with a number only that agent knows, then read the file.
 * The script plays the person: it allows any approval the child raises. The parent raises no start_agent card: in a
 * trusted project a `normal` session's start needs none (#673); one would be allowed too, and fail the check.
 *
 *   CHILD=codex (default: gpt-5.6-luna, low effort, the project's remembered choice) or CHILD=claude (haiku);
 *   WORKTREE=1 makes the project a git repository and has the child work in a new worktree (#561 part 2)
 *
 * Passes when: no agent_start card stood in the parent; a child opened in the same project
 * marked `askedBy` the parent, on the tool asked for, with the parent's preset; the file exists; and the parent's
 * final answer carries the number that is in the file.
 *
 * Run with: CHILD=codex node --import tsx packages/agent-host/scripts/smoke-start-agent.mts
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'

const CHILD = (process.env.CHILD ?? 'codex') as 'claude' | 'codex'
// WORKTREE=1 (#561 part 2): the project is a git repository and the child works in a new worktree of it
const WORKTREE = process.env.WORKTREE === '1'
const TOKEN = randomBytes(16).toString('hex')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-start-')))
const website = join(root, 'website')
for (const d of [website, join(root, 'data')]) mkdirSync(d, { recursive: true })
const log = (...a: unknown[]) => console.log('[start]', ...a)

const host = spawn('node', ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', join(root, 'store.db')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, CC_DATA_DIR: join(root, 'data') },
})
const port: number = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('host startup timeout')), 30000)
  host.stdout!.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      try {
        const j = JSON.parse(line)
        if (j.ready) {
          clearTimeout(t)
          res(j.port)
        }
      } catch {
        /* a log line */
      }
    }
  })
})

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
let n = 1
const pending = new Map<string, { r: (v: any) => void; j: (e: Error) => void }>()
const events: any[] = []
const rpc = (m: string, params: unknown): Promise<any> => {
  const id = String(n++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method: m, params }))
  return new Promise((r, j) => pending.set(id, { r, j }))
}
let parentId = ''
let child: any = null
const cards: { sessionId: string; detail: any }[] = []
ws.on('message', (raw: unknown) => {
  const f = JSON.parse(String(raw))
  if (f.kind === 'res') {
    const p = pending.get(f.id)
    if (p) {
      pending.delete(f.id)
      if (f.ok) p.r(f.result)
      else p.j(new Error(f.error?.message))
    }
    return
  }
  if (f.kind !== 'event') return
  const e = f.event
  events.push(e)
  if (e.type === 'session_created' && e.session?.askedBy) {
    child = e.session
    log('child opened:', e.session.name, `(${e.session.tool}, ${e.session.model ?? 'default model'}, ${e.session.permissionPreset})`)
  }
  if (e.type === 'approval_request') {
    cards.push({ sessionId: e.sessionId, detail: e.detail })
    log(`card in ${e.sessionId === parentId ? 'parent' : e.sessionId === child?.id ? 'child' : e.sessionId}: ${e.detail.kind} → allow`)
    void rpc('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision: 'allow' }).catch((err) => log('answer failed:', err.message))
  }
  if (e.type === 'tool_call' && e.sessionId === parentId) log('parent tool:', e.summary.tool, '·', String(e.summary.title).slice(0, 100))
})
await new Promise<void>((r) => ws.on('open', () => r()))
ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
await new Promise((r) => setTimeout(r, 300))

if (WORKTREE) {
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: website })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(website, 'README.md'), 'scratch\n')
  git('add', '.')
  git('commit', '-qm', 'init')
}
const project = await rpc('projects.add', { path: website })
await rpc('projects.setTrusted', { projectId: project.id, trusted: true })
// The project's own choice for the child's tool, as a person who used it would have left it (the child takes it)
const seed = await rpc('agents.createSession', { projectId: project.id, cwd: website, tool: CHILD, permissionPreset: 'normal' })
await rpc('agents.updateSettings', CHILD === 'codex' ? { sessionId: seed.id, model: 'gpt-5.6-luna', effort: 'low' } : { sessionId: seed.id, model: 'haiku' })
const parent = await rpc('agents.createSession', { projectId: project.id, cwd: website, tool: 'claude', model: 'haiku', permissionPreset: 'normal' })
parentId = parent.id
log('parent:', parentId, '· child tool:', CHILD)

const mark = events.length
const toolName = CHILD === 'codex' ? 'Codex' : 'Claude'
await rpc('agents.send', {
  sessionId: parentId,
  text:
    `Use start_agent to have ${toolName} (tool "${CHILD}") write a file out/secret.txt${WORKTREE ? ' in a new worktree (worktree: true)' : ' in this folder'} containing a random 6-digit number of its own choosing. ` +
    'Tell it not to put the number in its answer, only the absolute path of the file. Then read that file yourself and tell me the number.',
})
const ended = await new Promise<boolean>((resolve) => {
  const t = setInterval(() => {
    const mine = events.slice(mark).filter((e) => e.sessionId === parentId)
    if (mine.some((e) => e.type === 'turn_complete' || e.type === 'error')) {
      clearInterval(t)
      resolve(true)
    }
  }, 500)
  setTimeout(() => {
    clearInterval(t)
    resolve(false)
  }, 600_000)
})
const answer = events
  .slice(mark)
  .filter((e) => e.sessionId === parentId && e.type === 'message_delta')
  .map((e) => e.text)
  .join('')
const result = events.slice(mark).find((e) => e.sessionId === parentId && e.type === 'tool_result' && /answered|working|did not/.test(String(e.summary)))
const file = join(WORKTREE && child?.worktree ? child.worktree.path : website, 'out', 'secret.txt')
const number = existsSync(file) ? readFileSync(file, 'utf8').trim() : null
const consent = cards.find((c) => c.sessionId === parentId && c.detail.kind === 'agent_start')

console.log('\n── start_agent result (as the model read it) ──\n' + String(result?.summary ?? '(none)').slice(0, 400))
console.log('\n── parent answer ──\n' + answer.trim().slice(0, 600) + '\n')
const checks: [string, boolean][] = [
  ['the parent turn ended', ended],
  ['no agent_start card stood in the parent: the project\'s trust is the consent (#673)', !consent],
  ['a child opened in the same project, marked askedBy the parent', !!child && child.askedBy === parentId && child.projectId === project.id],
  [`the child runs ${CHILD} under the parent's preset`, !!child && child.tool === CHILD && child.permissionPreset === 'normal'],
  ...(WORKTREE ? [['the child works in a new worktree, not the project folder', !!child?.worktree && child.worktree.path !== website] as [string, boolean]] : []),
  ['the child wrote out/secret.txt', !!number],
  ['the parent answered with the number in the file', !!number && answer.includes(number.replace(/\D/g, '').slice(0, 6))],
]
for (const [what, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
ws.close()
host.kill()
rmSync(root, { recursive: true, force: true })
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
