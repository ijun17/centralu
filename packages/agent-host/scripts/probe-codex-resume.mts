/**
 * Probe (M1 of docs/plans/sleep-every-tool.md): what does a Codex thread cost to wake from a new app-server?
 *
 * One cell = one rollout, one idle time, one arm, in a CODEX_HOME of its own (a copy of the login and of the rollout,
 * never the real `~/.codex`; the copy is deleted at the end):
 *
 *   1. `thread/resume` (timed), a warm turn;
 *   2. `--idle-sec` of quiet;
 *   3. arm `resumed`: close the app-server (stdin EOF), start a new one (timed to `initialize`), `thread/resume` with
 *      `excludeTurns: true` (timed); arm `live`: nothing;
 *   4. a one-word turn: time to the first agent-message or reasoning delta, and the cache read of its first request
 *      (`tokenUsage.last.cachedInputTokens / inputTokens`).
 *
 *   node --import tsx packages/agent-host/scripts/probe-codex-resume.mts --rollout <file.jsonl> --idle-sec 120 --arm resumed [--model gpt-5.6-luna]
 *
 * Prints one JSON line starting `RESULT `.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient, type ServerNotification } from '../src/adapters/codex/client.js'
import { asObj, finite } from '../src/json-value.js'

const { values: o } = parseArgs({
  options: { rollout: { type: 'string' }, 'idle-sec': { type: 'string', default: '120' }, arm: { type: 'string', default: 'resumed' }, model: { type: 'string', default: 'gpt-5.6-luna' }, label: { type: 'string', default: '' } },
})
if (!o.rollout) throw new Error('--rollout is needed')
const root = mkdtempSync(join(tmpdir(), 'cc-probe-codex-resume-'))
const home = join(root, 'codex-home')
const work = join(root, 'work')
mkdirSync(work)
mkdirSync(join(home, 'sessions', '2026', '01', '01'), { recursive: true })
copyFileSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'))
writeFileSync(join(home, 'config.toml'), `model = "${o.model}"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n`)
const file = join(home, 'sessions', '2026', '01', '01', basename(o.rollout))
copyFileSync(o.rollout, file)
const threadId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1]
if (!threadId) throw new Error(`--rollout must be a rollout file named after its thread id (<uuid>.jsonl): ${o.rollout}`)
const mb = statSync(file).size / 1e6
process.env.CODEX_HOME = home

type Mark = { at: number; first: number | null; cached: number | null; input: number | null; updates: number }
let mark: Mark | null = null
let turnDone: (() => void) | null = null
const onNotification = (n: ServerNotification) => {
  if (!mark) return
  const m = n.method
  if (mark.first === null && (m === 'item/agentMessage/delta' || m.includes('reasoning') && m.endsWith('Delta'))) mark.first = Date.now() - mark.at
  if (m === 'thread/tokenUsage/updated') {
    const last = asObj(asObj(asObj(n.params).tokenUsage).last)
    const input = finite(last.inputTokens)
    if (input !== undefined && input > 0) {
      // The last reading of the turn: the first one can repeat the previous turn's. A one-word turn with no tool is one request
      mark.input = input
      mark.cached = finite(last.cachedInputTokens) ?? null
      mark.updates++
    }
  }
  if (m === 'turn/completed') turnDone?.()
}
let exits = 0
const open = async () => {
  const t = Date.now()
  const c: CodexClient = new CodexClient(
    { onNotification, onServerRequest: (r) => c.respond(r.id, { decision: 'accept' }), onExit: () => void exits++ },
    { cwd: work },
  )
  await c.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
  c.notify('initialized')
  return { c, spawnMs: Date.now() - t }
}
const resume = async (c: CodexClient, excludeTurns: boolean) => {
  const t = Date.now()
  await c.request('thread/resume', { threadId, cwd: work, model: o.model, approvalPolicy: 'never', sandbox: 'read-only', ...(excludeTurns ? { excludeTurns: true } : {}) })
  return Date.now() - t
}
const turn = async (c: CodexClient, text: string): Promise<Mark> => {
  mark = { at: Date.now(), first: null, cached: null, input: null, updates: 0 }
  const done = new Promise<void>((r) => (turnDone = r))
  await c.request('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text }] })
  await Promise.race([done, new Promise((_, j) => setTimeout(() => j(new Error('turn timed out')), 300_000))])
  await new Promise((r) => setTimeout(r, 1500))
  const m = mark
  mark = null
  return m
}
const say = 'Reply with the single word: ok. Do not use any tool.'
const out: Record<string, unknown> = { label: o.label, rolloutMB: Math.round(mb * 10) / 10, idleSec: Number(o['idle-sec']), arm: o.arm }
try {
  let { c, spawnMs } = await open()
  out.firstSpawnMs = spawnMs
  out.firstResumeMs = await resume(c, false)
  const warm = await turn(c, say)
  out.warm = warm
  await new Promise((r) => setTimeout(r, Number(o['idle-sec']) * 1000))
  if (o.arm === 'resumed') {
    await c.dispose()
    await new Promise((r) => setTimeout(r, 500))
    ;({ c, spawnMs } = await open())
    out.spawnMs = spawnMs
    out.resumeMs = await resume(c, true)
  }
  const woken = await turn(c, say)
  out.woken = { ...woken, cacheRead: woken.input ? (woken.cached ?? 0) / woken.input : null }
  await c.dispose()
} catch (e) {
  out.error = String(e)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('RESULT ' + JSON.stringify(out))
process.exit(0)
