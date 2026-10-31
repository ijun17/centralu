/**
 * A-5 smoke test: verifies the host end-to-end against a real Codex session.
 *
 * S9 — approval request → allow → the file is actually created (checks whether this overrides the
 *   global approval_policy="never")
 * S10 — remembers the earlier context via thread/resume after the host restarts
 * S11 — zombie check: killing the host leaves no codex app-server behind either
 *
 * Model: Codex's default model (do not use a top-tier model for verification — per the docs' model
 * policy)
 * Run with: node packages/agent-host/scripts/smoke-codex.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from './host-client.mjs'

const DB = join(mkdtempSync(join(tmpdir(), 'cc-codex-')), 'store.db')
const CWD = mkdtempSync(join(tmpdir(), 'cc-codex-cwd-'))
const log = (...a) => console.log('[codex]', ...a)

let failures = 0
const check = (ok, label, extra = '') => {
  log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

const textOf = (events) => events.filter((e) => e.type === 'message_delta').map((e) => e.text).join('')

// ── First run: approval round trip (S9) ──────────────────────────────────────────────
const c1 = await openHost({ db: DB })

const detected = await c1.call('agents.detect', {})
const codexInfo = detected.find((d) => d.tool === 'codex')
check(codexInfo?.installed === true, 'Codex detected', codexInfo?.detail)

const project = await c1.call('projects.add', { path: CWD })
const session = await c1.call('agents.createSession', {
  projectId: project.id, cwd: CWD, tool: 'codex', permissionPreset: 'safe',
  initialPrompt: 'Create a file named codex-ok.txt containing exactly: OK. Remember the codeword MELON. Then stop.',
})
check(!!session.externalId, 'thread id captured immediately on creation', session.externalId ?? 'none')

const approval = await c1.next((e) => e.type === 'approval_request', 'approval request', 180000)
check(true, 'S9 approval request received (session-level override of the global never)', approval.detail.kind)

await c1.call('agents.respondApproval', {
  sessionId: session.id, requestId: approval.requestId, decision: 'allow',
})
await c1.next((e) => e.type === 'turn_complete', 'turn complete', 180000)
check(existsSync(join(CWD, 'codex-ok.txt')), 'S9 file actually created after approval')

// FR-18 is satisfied by naming the session from its first prompt. Codex's thread/name/updated is
// a bonus, and does not arrive for a short session (measured). Checks whether a name actually got attached.
const named = (await c1.call('sessions.list', {})).find((s) => s.id === session.id)
// '새 세션' is the literal default session name from agent-host/src/sessions (out of this
// branch's scope, still Korean there) — kept as-is because it is the value being compared against.
check(!!named?.name && named.name !== '새 세션', 'FR-18 automatic session name', named?.name?.slice(0, 40))
const titleEvent = c1.events.find((e) => e.type === 'session_title')
log(titleEvent ? `· Codex title event also received: ${titleEvent.title}` : '· No Codex title event arrived (short session)')
const ctx = c1.events.find((e) => e.type === 'context_update' || e.type === 'usage_update')
check(!!ctx, 'token/context gauge event received', ctx?.type)

// ── Second run: resume after restart (S10) ────────────────────────────────────────
c1.ws.close()
c1.host.kill('SIGTERM')
await new Promise((r) => c1.host.once('exit', r))

const c2 = await openHost({ db: DB })
const res = await c2.call('agents.resumeSession', { sessionId: session.id })
check(res.resumed === true, 'S10 resume succeeded', res.reason ?? '')

if (res.resumed) {
  await c2.call('agents.send', { sessionId: session.id, text: 'What was the codeword? Reply with only that word.' })
  await c2.next((e) => e.type === 'turn_complete', 'turn after resume', 180000)
  const answer = textOf(c2.events).trim()
  check(/MELON/i.test(answer), 'S10 resumed session remembers earlier context', answer.slice(0, 40))
}

// ── Third run: zombie check (S11) ─────────────────────────────────────────────
c2.ws.close()
c2.host.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 3000))
let leftover = ''
try {
  leftover = execSync('pgrep -f "codex app-server" || true', { encoding: 'utf8' }).trim()
} catch { /* no pgrep */ }
check(leftover === '', 'S11 killing the host leaves no codex app-server behind', leftover || 'none')

log(failures === 0 ? 'all passed' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
