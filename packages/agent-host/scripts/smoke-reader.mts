/* eslint-disable @typescript-eslint/no-explicit-any -- the smoke test reads the host's raw frames directly */
/**
 * #320 end to end: **does an ordinary session reach for its reader set, and does the project
 * boundary hold with a real model?**
 *
 * The unit tests pin what the set holds and where its view ends. Whether a real session, asked
 * about its project, calls read_session and recall — and gets nothing from another project — can
 * only be known here. Three haiku turns seed two projects; the fourth asks.
 *
 * Nothing touches the real data folder: the host runs in memory with CC_DATA_DIR in a temp folder.
 *
 * Run with: node --import tsx packages/agent-host/scripts/smoke-reader.mts
 * (TOOL=codex runs the asking session on Codex, through the bridge.)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const TOKEN = 'reader-smoke'
const root = mkdtempSync(join(tmpdir(), 'cc-reader-smoke-'))
const shop = mkdtempSync(join(root, 'shop-'))
const other = mkdtempSync(join(root, 'other-'))
for (const d of [shop, other]) writeFileSync(join(d, 'README.md'), '# scratch\n')
const TOOL = (process.env.TOOL ?? 'claude') as 'claude' | 'codex'
const MODEL = TOOL === 'claude' ? 'haiku' : undefined
const log = (...a: unknown[]) => console.log('[reader]', ...a)

const host = spawn('node', ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--memory'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, CC_DATA_DIR: join(root, 'data') },
})
const port: number = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('host startup timeout')), 20000)
  host.stdout!.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      try {
        const j = JSON.parse(line)
        if (j.ready) { clearTimeout(t); res(j.port) }
      } catch { /* log line */ }
    }
  })
})

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
let n = 1
type Json = Record<string, any>
const pending = new Map<string, { r: (v: Json) => void; j: (e: Error) => void }>()
const events: Json[] = []
ws.on('message', (raw: unknown) => {
  const f = JSON.parse(String(raw))
  if (f.kind === 'res') {
    const p = pending.get(f.id)
    if (p) { pending.delete(f.id); if (f.ok) p.r(f.result); else p.j(new Error(f.error?.message)) }
  } else if (f.kind === 'event') events.push(f.event)
})
const rpc = (m: string, params: unknown): Promise<Json> => {
  const id = String(n++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method: m, params }))
  return new Promise((r, j) => {
    pending.set(id, { r, j })
    setTimeout(() => pending.has(id) && (pending.delete(id), j(new Error(m + ' timeout'))), 240000)
  })
}
await new Promise<void>((r) => ws.on('open', () => r()))
ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
await new Promise((r) => setTimeout(r, 300))

/** Sends one message and waits for the turn to finish; returns the events of that turn */
async function turn(sessionId: string, text: string): Promise<Json[]> {
  const mark = events.length
  await rpc('agents.send', { sessionId, text })
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (events.slice(mark).some((e) => e.sessionId === sessionId && e.type === 'turn_complete')) { clearInterval(t); resolve() }
    }, 500)
    setTimeout(() => { clearInterval(t); resolve() }, 180000)
  })
  return events.slice(mark).filter((e) => e.sessionId === sessionId)
}
const session = async (projectId: string, cwd: string, name: string, tool: 'claude' | 'codex', model: string | undefined) => {
  const s = await rpc('agents.createSession', { projectId, cwd, tool, permissionPreset: 'auto', ...(model ? { model } : {}) })
  await rpc('sessions.rename', { sessionId: s.id, name })
  return s.id as string
}

const pShop = await rpc('projects.add', { path: shop })
const pOther = await rpc('projects.add', { path: other })
const sibling = await session(pShop.id, shop, 'db-migration', 'claude', 'haiku')
const stranger = await session(pOther.id, other, 'other-project', 'claude', 'haiku')
await turn(sibling, 'Reply with exactly this sentence and nothing else: We chose pgdump for the nightly backup.')
await turn(stranger, 'Reply with exactly this sentence and nothing else: The zanzibar launch code is 4417.')
log('seeded: sibling', sibling, '· stranger', stranger)

const me = await session(pShop.id, shop, 'me', TOOL, MODEL)
const asked = await turn(
  me,
  'Which other Centralu sessions are in this project, and what did we decide about backups in an earlier conversation? ' +
    'Also: is there anything about "zanzibar" in our past conversations?',
)
const calls = asked.filter((e) => e.type === 'tool_call').map((e) => `${e.summary.tool}: ${String(e.summary.title).slice(0, 80)}`)
const results = asked.filter((e) => e.type === 'tool_result').map((e) => String(e.output ?? e.summary ?? ''))
const said = asked.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')
console.log('\n── Tool calls ──\n' + (calls.join('\n') || '(none)'))
console.log('\n── What it said ──\n' + said.trim().slice(0, 900) + '\n')
// A turn that says nothing is a turn that failed — show what happened instead of only "not called"
if (!said.trim()) console.log('── Events ──\n' + asked.map((e) => (e.type === 'error' || e.type === 'notice' ? `${e.type}: ${JSON.stringify(e.error ?? e.text)}` : e.type)).join('\n'))

const usedRead = calls.some((c) => c.includes('read_session'))
const usedRecall = calls.some((c) => c.includes('recall'))
const leaked = said.includes('4417') || results.some((r) => r.includes('4417') || r.includes(stranger))
const foundSibling = said.includes('db-migration') && /pg_?dump/i.test(said)
console.log(`  read_session called          ${usedRead ? '✅' : '❌'}`)
console.log(`  recall called                ${usedRecall ? '✅' : '❌'}`)
console.log(`  found the sibling's decision ${foundSibling ? '✅' : '❌'}`)
console.log(`  other project stayed out     ${leaked ? '❌ LEAKED' : '✅'}`)

ws.close()
host.kill()
rmSync(root, { recursive: true, force: true })
const ok = usedRead && usedRecall && foundSibling && !leaked
console.log(ok ? '\n✅ #320 passed' : '\n❌ check failed')
process.exit(ok ? 0 : 1)
