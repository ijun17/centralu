/**
 * Manual, billable Haiku probe for the unanswered reminder's cost per wake (#2477, docs/plans/mailbox.md §10.5).
 * Run: pnpm exec tsx packages/agent-host/scripts/probe-reminder-cost.mts [--answer]
 * Uses the person's Claude authentication; the project and CC_DATA_DIR are temporary, and only the host it starts is stopped.
 *
 * Two Claude sessions on one host, every request through the measurement's recorder (`measure-tools/recorder.mts`). B is
 * told to leave mail unanswered (with `--answer`: until Centralu reminds it, then to read and answer it); A sends B a question
 * with the mail tool. B's turn on it ends, B is at rest, and about
 * 2 to 3 minutes later the host reminds it: the requests of that reminder's turn, and their usage, are printed.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MeasuredHost, type Json } from './measure-tools/host.mjs'
import { ApiRecorder } from './measure-tools/recorder.mjs'

const ANSWER = process.argv.includes('--answer')
const root = mkdtempSync(join(tmpdir(), 'cc-probe-reminder-'))
const data = join(root, 'data')
const project = join(root, 'project')
mkdirSync(data)
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# A scratch project for the reminder probe\n')
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project })
execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'add', '.'], { cwd: project })
execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'commit', '-q', '-m', 'init'], { cwd: project })

const recorder = new ApiRecorder('forward')
const port = await recorder.start()
const host = new MeasuredHost(data, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ENABLE_TOOL_SEARCH: 'true',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
})
/** The id the host answered with: its answer is the host's raw frame */
const idOf = (answer: Json): string => {
  const id: unknown = answer.id
  if (typeof id !== 'string') throw new Error('the host answered without an id')
  return id
}
const ended = (sessionId: string, since: number) => host.events.slice(since).some((e: Json) => e.sessionId === sessionId && e.type === 'turn_complete')

try {
  await host.start()
  const projectId = idOf(await host.rpc('projects.add', { path: project }))
  await host.rpc('projects.setTrusted', { projectId, trusted: true })
  const make = async () => idOf(await host.rpc('agents.createSession', { projectId, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'normal' }))
  const a = await make()
  const b = await make()
  recorder.mark('b', 'setup', 'person')
  await host.turn(b, ANSWER
    ? 'For this whole conversation: when Centralu mail arrives with a question, do not read or answer it; reply only "noted". When Centralu reminds you of it, read it and answer it with the mail tool. Now reply "ready".'
    : 'For this whole conversation: when Centralu mail arrives, do not answer it, do not mark it handled and do not read it. Reply only with the word "noted" and end your turn. Now reply "ready".')
  recorder.mark('a', 'send', 'person')
  const mark = host.events.length
  await host.turn(a, `Call the mail tool exactly once: action "send", to "${b}", text "What is 2 + 2? Answer when you can.", kind "question". Then end your turn.`)
  // B's turn on the question
  const until = Date.now() + 120_000
  while (Date.now() < until && !ended(b, mark)) await delay(500)
  if (!ended(b, mark)) throw new Error('B was never woken by the question')
  const atRest = host.events.length
  const before = recorder.requests.length
  recorder.mark('b', 'reminder', 'reminder')
  const restAt = Date.now()
  const limit = Date.now() + 6 * 60_000
  while (Date.now() < limit && !ended(b, atRest)) await delay(1_000)
  if (!ended(b, atRest)) throw new Error('no reminder turn within 6 minutes')
  await delay(1_500)
  await recorder.settle()
  const turn = recorder.requests.slice(before).filter((r) => r.session === 'b' && r.main)
  const sum = (k: 'input' | 'cacheRead' | 'cacheWrite' | 'output') => turn.reduce((n, r) => n + (r.usage?.[k] ?? 0), 0)
  console.log(JSON.stringify({
    reminderAfterSeconds: Math.round((Date.now() - restAt) / 1000),
    requests: turn.length,
    perRequest: turn.map((r) => ({ messages: r.messages, ...r.usage })),
    total: { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output') },
  }, null, 2))
} finally {
  await host.stop()
  await recorder.stop()
  rmSync(root, { recursive: true, force: true })
}
