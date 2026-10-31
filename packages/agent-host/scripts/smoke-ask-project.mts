/* eslint-disable @typescript-eslint/no-explicit-any -- the smoke test reads the host's raw frames directly */
/**
 * #371 part B end to end: **does a real session in one project ask another project, and read back the file it made?**
 *
 * Two scratch projects under a temp root, a host on a temp store and data folder (never `~/.centralu`). A Claude
 * haiku session in "consumer" (preset safe, so a read outside its folder would raise a card) is told to have
 * "toolkit" write a file with a number only toolkit knows, then read that file. The script plays the person: it
 * answers the consent card "always", and allows any approval the delegated session raises.
 *
 *   CALLEE=claude (default, haiku) or CALLEE=codex (gpt-5.6-luna, low effort) picks toolkit's agent; CALLER the same
 *   for consumer's (Codex reaches ask_project through the bridge, and does not restrict reads, so the read-grant
 *   check is Claude's only).
 *
 * Passes when: the consent card stood in the caller with the project_access detail; the existing toolkit session received the task
 * with caller provenance; the file exists; the caller's final answer carries the number that is in the file; and the
 * caller's read of that file raised no card (the read grant).
 *
 * Run with: node --import tsx packages/agent-host/scripts/smoke-ask-project.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from './host-client.mjs'

const CALLEE = (process.env.CALLEE ?? 'claude') as 'claude' | 'codex'
const CALLER = (process.env.CALLER ?? 'claude') as 'claude' | 'codex'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-ask-')))
const consumer = join(root, 'consumer')
const toolkit = join(root, 'toolkit')
for (const d of [consumer, toolkit, join(root, 'data')]) mkdirSync(d, { recursive: true })
const log = (...a: unknown[]) => console.log('[ask]', ...a)

let callerId = ''
let delegatedId = ''
const cards: { sessionId: string; detail: any }[] = []
const { host, ws, events, call: rpc, next } = await openHost({
  db: join(root, 'store.db'),
  env: { CC_DATA_DIR: join(root, 'data') },
  onEvent: (e) => {
    if (e.type === 'approval_request') {
      cards.push({ sessionId: e.sessionId, detail: e.detail })
      // The person: "always" for the pair, and allow whatever the delegated session asks
      const decision = e.detail.kind === 'project_access' ? 'always' : 'allow'
      log(`card in ${e.sessionId === callerId ? 'caller' : e.sessionId === delegatedId ? 'delegated' : e.sessionId}: ${e.detail.kind} → ${decision}`)
      void rpc('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision }).catch((err) => log('answer failed:', err.message))
    }
    if (e.type === 'tool_call' && e.sessionId === callerId) log('caller tool:', e.summary.tool, '·', String(e.summary.title).slice(0, 100))
  },
})

const pc = await rpc('projects.add', { path: consumer })
const pt = await rpc('projects.add', { path: toolkit })
// The script plays the person: trust the scratch projects and open the session that receives the task.
await rpc('projects.setTrusted', { projectId: pc.id, trusted: true })
await rpc('projects.setTrusted', { projectId: pt.id, trusted: true })
const seed = await rpc('agents.createSession', { projectId: pt.id, cwd: toolkit, tool: CALLEE, permissionPreset: 'normal' })
await rpc('agents.updateSettings', CALLEE === 'codex' ? { sessionId: seed.id, model: 'gpt-5.6-luna', effort: 'low' } : { sessionId: seed.id, model: 'haiku' })
const caller = await rpc(
  'agents.createSession',
  CALLER === 'codex'
    ? { projectId: pc.id, cwd: consumer, tool: 'codex', model: 'gpt-5.6-luna', effort: 'low', permissionPreset: 'safe' }
    : { projectId: pc.id, cwd: consumer, tool: 'claude', model: 'haiku', permissionPreset: 'safe' },
)
callerId = caller.id
delegatedId = seed.id
log('caller:', callerId, '· caller tool:', CALLER, '· callee tool:', CALLEE)

const mark = events.length
await rpc('agents.send', {
  sessionId: callerId,
  text:
    'Use ask_project to have the project "toolkit" write a file out/secret.txt in its folder containing a random 6-digit number of its own choosing. ' +
    'Tell it not to put the number in its answer, only the absolute path of the file. Then read that file yourself and tell me the number.',
})
const ended = await next((e) => e.sessionId === callerId && (e.type === 'turn_complete' || e.type === 'error'), 'caller turn end', 600_000, mark).then(() => true, () => false)
const answer = events
  .slice(mark)
  .filter((e) => e.sessionId === callerId && e.type === 'message_delta')
  .map((e) => e.text)
  .join('')
const result = events.slice(mark).find((e) => e.sessionId === callerId && e.type === 'tool_result' && /answered|still working|did not/.test(String(e.summary)))
const file = join(toolkit, 'out', 'secret.txt')
const number = existsSync(file) ? readFileSync(file, 'utf8').trim() : null
const consent = cards.find((c) => c.sessionId === callerId && c.detail.kind === 'project_access')
const callerReadCards = cards.filter((c) => c.sessionId === callerId && c.detail.kind !== 'project_access')

console.log('\n── ask_project result (as the model read it) ──\n' + String(result?.summary ?? '(none)').slice(0, 400))
console.log('\n── caller answer ──\n' + answer.trim().slice(0, 600) + '\n')
const checks: [string, boolean][] = [
  ['the caller turn ended', ended],
  ['consent card stood in the caller (project_access, delegate)', !!consent && consent.detail.access === 'delegate'],
  ['the consent names the existing session', consent?.detail.session?.id === delegatedId],
  ['the existing toolkit session received a task from the caller', events.slice(mark).some((e) => e.type === 'user_message' && e.sessionId === delegatedId && e.from?.sessionId === callerId)],
  ['no session was created by ask_project', !events.slice(mark).some((e) => e.type === 'session_created')],
  ['toolkit wrote out/secret.txt', !!number],
  ['the caller answered with the number in the file', !!number && answer.includes(number.replace(/\D/g, '').slice(0, 6))],
  ...(CALLER === 'claude' ? [['the caller read the file without a card (read grant)', callerReadCards.length === 0] as [string, boolean]] : []),
]
for (const [what, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
ws.close()
host.kill()
rmSync(root, { recursive: true, force: true })
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
