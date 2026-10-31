/**
 * M1.5 L3 smoke test: verifies **resume (FR-10)** end-to-end against a real Claude session.
 *
 * S5 — the same conversation continues even after the host is shut down and restarted (actually
 *   asks whether it remembers the earlier context)
 * S6 — if the resume identifier is broken, it fails with a reason instead of dying silently
 *
 * The verification model is haiku (per the docs' model policy: do not use a top-tier model for
 * verification).
 * Run with: node packages/agent-host/scripts/smoke-resume.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from './host-client.mjs'

const DB = join(mkdtempSync(join(tmpdir(), 'cc-resume-')), 'store.db') // The store shared by both host runs
const CWD = mkdtempSync(join(tmpdir(), 'cc-resume-cwd-'))
const log = (...a) => console.log('[resume]', ...a)

const textOf = (events) =>
  events.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

// ── First host run: create a session and say something worth remembering ──────────────────
const c1 = await openHost({ db: DB })
const project = await c1.call('projects.add', { path: CWD })
const session = await c1.call('agents.createSession', {
  projectId: project.id, cwd: CWD, tool: 'claude', model: 'haiku', permissionPreset: 'safe',
  initialPrompt: 'Remember this codeword: PLUM. Reply with only: OK',
})
await c1.next((e) => e.type === 'turn_complete', 'turn end')
log('first response:', JSON.stringify(textOf(c1.events).trim().slice(0, 60)))

// The SDK tells us the session id only in the first init event — it may not exist yet at the moment
// of the create response. What matters is that it is guaranteed to be saved once the first turn
// ends (otherwise resuming is impossible).
const afterFirstTurn = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
check(!!afterFirstTurn?.externalId, 'the resume identifier is saved after the first turn', afterFirstTurn?.externalId ?? 'none')

// ── Shut down the host (simulating the user quitting and reopening the app) ─────────────────────────
c1.ws.close()
c1.host.kill('SIGTERM')
await new Promise((r) => c1.host.once('exit', r))
log('host shut down — the process is gone, only the record remains')

// ── Second host run: start again against the same store and resume ─────────────────
const c2 = await openHost({ db: DB })

const restored = await c2.call('sessions.list', {})
const target = restored.find((s) => s.id === session.id)
check(!!target, 'the session remains in the list even after a restart')
check(target?.live === false, 'shown as live=false since there is no process', `live=${target?.live}`)

// S6 first: does an unresumable situation avoid dying silently
const broken = await c2.call('agents.resumeSession', { sessionId: 'no-such-session' }).catch((e) => e)
check(broken instanceof Error, 'S6 resuming a nonexistent session reports an error', broken?.message?.slice(0, 40))

// S5: the actual resume
const res = await c2.call('agents.resumeSession', { sessionId: session.id })
check(res.resumed === true, 'S5 resume succeeded', res.reason ?? '')

if (res.resumed) {
  await c2.call('agents.send', { sessionId: session.id, text: 'What was the codeword? Reply with only that word.' })
  await c2.next((e) => e.type === 'turn_complete', 'turn end')
  const answer = textOf(c2.events).trim()
  log('second response:', JSON.stringify(answer.slice(0, 60)))
  check(/PLUM/i.test(answer), 'S5 resumed session remembers earlier context', answer.slice(0, 40))
}

c2.ws.close()
c2.host.kill('SIGTERM')
log(failures === 0 ? 'all passed' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
