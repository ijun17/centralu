/**
 * Probe: does a Claude session the host put to sleep read the prompt cache when it wakes (#568)?
 *
 * Sleeping an idle session (sessions/sleep.ts) is only free because a resumed Claude process reads the prompt cache as
 * the live one would have: measured in #561 at ~100% after 2, 6 and 10 minutes on the 1 h lifetime, +0.7 s (p50)
 * before the first token. A CLI update could change either (how resume rebuilds the request, what it caches), and
 * nothing else would notice: the session would still wake, only slower and dearer. Run this on a Claude Code update,
 * next to `pnpm drift:claude` (docs/agent-host/adapters/vendor-drift-checks.md).
 *
 * Live, on the person's own Claude login, on haiku. One host on a temporary data folder (`CC_DATA_DIR` and `--db`
 * inside it, never `~/.centralu`), auto memory and claude.ai connectors off, the host's quiet period shortened with
 * `CC_SLEEP_AFTER_MS`:
 *
 *   1. a turn with a large block unique to this run (its own cache prefix), then an ordinary turn (the warm reading);
 *   2. the host puts the session to sleep by itself (its `session_live` event, the process gone);
 *   3. `--gap-sec` more of quiet (default 0), then a message, which wakes it: the woken turn's first request is
 *      compared with the warm one. It passes when it reads at least `--min-read` (default 0.9) of its input from cache.
 *
 *   pnpm exec tsx packages/agent-host/scripts/probe-resume-cache.mts [--sleep-sec 20] [--gap-sec 0] [--min-read 0.9] [--model haiku]
 *
 * Exits 1 when the woken turn misses the cache or the session never slept.
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { MeasuredHost, type Json } from './measure-tools/host.mjs'

const { values: opt } = parseArgs({
  options: {
    'sleep-sec': { type: 'string', default: '20' },
    'gap-sec': { type: 'string', default: '0' },
    'min-read': { type: 'string', default: '0.9' },
    model: { type: 'string', default: '' },
    // Another tool that sleeps (Codex, #2027): `--tool codex --model gpt-5.6-luna`. With `--idle-sec 120 --arm resumed|live`, a restart in place of the sleep, for a tool that does not sleep (docs/plans/sleep-every-tool.md M1b, M3)
    tool: { type: 'string', default: 'claude' },
    'idle-sec': { type: 'string', default: '0' },
    arm: { type: 'string', default: 'resumed' },
    // Instead of the idle time: a background shell started in the turn, and whether it survives the restart (M3)
    background: { type: 'boolean', default: false },
  },
})

if (!opt.model && (opt.tool ?? 'claude') === 'claude') opt.model = 'haiku'
const root = mkdtempSync(join(tmpdir(), 'cc-probe-resume-cache-'))
const sleepMs = Number(opt['sleep-sec']) * 1000
/** A restart in place of the sleep (M1b, M3): the host must not put the session to sleep on its own meanwhile, so its quiet period is a day */
const restartArm = opt.background || Number(opt['idle-sec']) > 0
const ENV: Record<string, string> = {
  ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CC_SLEEP_AFTER_MS: String(restartArm ? 24 * 3600_000 : sleepMs),
}

function project(): string {
  const dir = join(root, 'project')
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), '# probe\n\nA scratch project for the resume cache probe.\n')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return dir
}

/** About 8k tokens no other conversation has, so this conversation's cache prefix is its own */
function uniqueBlock(lines = 700): string {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet']
  return Array.from({ length: lines }, (_, i) => `Line ${i}: ${words[i % 10]} ${randomBytes(3).toString('hex')} ${words[(i * 7) % 10]}`).join('\n')
}

type Request = { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; cacheTtl?: string }
const requestsOf = (events: Json[]): Request[] => events.filter((e) => e.type === 'usage_update' && e.request).map((e) => e.request as Request)
const total = (r: Request) => r.inputTokens + r.cacheReadTokens + (r.cacheCreationTokens ?? 0)
const show = (label: string, r: Request | undefined) =>
  console.log(
    r
      ? `  ${label}: input ${r.inputTokens}, read ${r.cacheReadTokens}, wrote ${r.cacheCreationTokens} of ${total(r)} (read ${(r.cacheReadTokens / total(r)).toFixed(3)}), ttl ${r.cacheTtl ?? '-'}`
      : `  ${label}: no request seen`,
  )

const say = 'Reply with the single word: ok'
const code = `KUMQUAT-${randomBytes(3).toString('hex')}`
let failed = false
const host = new MeasuredHost(join(root, 'data'), ENV)
try {
  mkdirSync(join(root, 'data'))
  await host.start()
  const dir = project()
  const p = await host.rpc('projects.add', { path: dir })
  await host.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  const s = await host.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: opt.tool, ...(opt.model ? { model: opt.model } : {}), permissionPreset: opt.tool === 'cursor-agent' ? 'auto' : 'normal' })
  if (opt.model && s.model !== opt.model) await host.rpc('agents.updateSettings', { sessionId: s.id, model: opt.model })

  console.log(`# warm (${opt.model})`)
  await host.turn(s.id, `Remember this code word: ${code}. Reference text follows; do not repeat it.\n\n${uniqueBlock()}\n\n${say}`)
  const tWarm = Date.now()
  const warm = requestsOf(await host.turn(s.id, say)).at(-1)
  const warmMs = Date.now() - tWarm
  show('warm turn', warm)
  console.log(`  the turn took ${warmMs} ms (send to its end)`)

  if (restartArm) {
    // The idle time passes, then (arm `resumed`) `agents.restartSession` swaps the process as a sleep and a wake would; `live` leaves it
    if (opt.background) {
      const mark = '30' + Math.floor(Math.random() * 90 + 10)
      await host.turn(s.id, `Start this exact shell command in the background and reply "started" as soon as it is started: nohup sleep ${mark} >/dev/null 2>&1 &`)
      await new Promise((r) => setTimeout(r, 2000))
      const find = () => execFileSync('ps', ['-axo', 'pid,ppid,command']).toString().split('\n').filter((l) => new RegExp(`sleep ${mark}\\b`).test(l) && !l.includes('grep')).map((l) => l.trim())
      const before = find()
      await host.rpc('agents.restartSession', { sessionId: s.id })
      await new Promise((r) => setTimeout(r, 1500))
      const after = find()
      console.log('RESULT ' + JSON.stringify({ tool: opt.tool, background: true, childBeforeRestart: before, childAfterRestart: after }))
      for (const l of after) process.kill(Number(l.split(/\s+/)[0]), 'SIGTERM')
      await host.stop()
      rmSync(root, { recursive: true, force: true })
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, Number(opt['idle-sec']) * 1000))
    let restartMs: number | null = null
    if (opt.arm === 'resumed') {
      const t = Date.now()
      await host.rpc('agents.restartSession', { sessionId: s.id })
      restartMs = Date.now() - t
    }
    const mark = host.events.length
    const sent = Date.now()
    const turn = await host.turn(s.id, 'What was the code word I told you to remember? Reply with only the word. Do not use any tool.')
    const recalled = turn.filter((e) => e.type === 'message_delta').map((e) => e.text ?? '').join('').includes(code)
    const first = turn.findIndex((e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
    const firstMs = first < 0 ? null : host.eventAt[mark + host.events.slice(mark).findIndex((e) => e === turn[first])]! - sent
    const woken = requestsOf(turn).at(-1)
    show('woken turn', woken)
    const r = woken ? woken.cacheReadTokens / total(woken) : null
    console.log('RESULT ' + JSON.stringify({ tool: opt.tool, arm: opt.arm, idleSec: Number(opt['idle-sec']), restartMs, ttftMs: firstMs, turnMs: Date.now() - sent, warmTurnMs: warmMs, warm, woken, cacheRead: r, recalledCode: recalled, answer: JSON.stringify(turn.filter((e) => e.type === 'message_delta' || e.type === 'message').map((e) => e.text)).slice(0, 120), code }))
    await host.stop()
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }

  console.log(`\n# waiting for the host to put it to sleep (CC_SLEEP_AFTER_MS=${sleepMs})`)
  const t0 = Date.now()
  const slept = () => host.events.some((e) => e.type === 'session_live' && e.sessionId === s.id && e.live === false)
  while (!slept() && Date.now() - t0 < sleepMs + 120_000) await new Promise((r) => setTimeout(r, 250))
  const listed = (await host.rpc('sessions.list', {})) as Json[]
  const asleep = slept() && listed.find((x) => x.id === s.id)?.live === false
  console.log(`  ${asleep ? `asleep after ${Math.round((Date.now() - t0) / 1000)} s of quiet` : 'never slept'}`)
  if (!asleep) failed = true

  const gap = Number(opt['gap-sec'])
  if (gap > 0) {
    console.log(`\n# ${gap} s more of quiet`)
    await new Promise((r) => setTimeout(r, gap * 1000))
  }

  console.log('\n# a message wakes it')
  const sent = Date.now()
  const turn = await host.turn(s.id, say)
  const wokenMs = Date.now() - sent
  const woke = turn.find((e) => e.type === 'session_live' && e.live === true)
  const woken = requestsOf(turn)[0]
  show('woken turn', woken)
  console.log(`  woke: ${woke ? 'yes' : 'no'}; the turn took ${wokenMs} ms (send to its end, the resume included), the warm one ${warmMs} ms`)
  const read = woken ? woken.cacheReadTokens / total(woken) : 0
  const min = Number(opt['min-read'])
  if (!woke || read < min) failed = true
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: the woken turn read ${(read * 100).toFixed(1)}% of its input from cache (at least ${min * 100}% expected)`)
} finally {
  await host.stop()
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
