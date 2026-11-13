/**
 * Probe (M2 of docs/plans/sleep-every-tool.md): can one `codex app-server` hold every thread of an account?
 *
 * One app-server in a CODEX_HOME of its own (a copy of the login, never the real `~/.codex`), N threads with their own cwd
 * and their own `config`, checked against the gates (a)-(h) of §3:
 *
 *   node --import tsx packages/agent-host/scripts/probe-codex-shared.mts [--rollout <big.jsonl>] [--model gpt-5.6-luna]
 *
 * Prints `GATE x: ...` lines and one `RESULT {json}`. `--rollout` (a large rollout, copied in) is needed for (f).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { CLIENT_INFO } from '@cc/protocol'
import { CodexClient, type ServerNotification, type ServerRequest } from '../src/adapters/codex/client.js'

const { values: o } = parseArgs({ options: { rollout: { type: 'string' }, model: { type: 'string', default: 'gpt-5.6-luna' }, 'only-f': { type: 'boolean', default: false } } })
const root = mkdtempSync(join(tmpdir(), 'cc-probe-codex-shared-'))
const home = join(root, 'codex-home')
mkdirSync(join(home, 'sessions', '2026', '01', '01'), { recursive: true })
copyFileSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'))
writeFileSync(join(home, 'config.toml'), `model = "${o.model}"\nmodel_reasoning_effort = "low"\n`)
process.env.CODEX_HOME = home
const neutral = join(root, 'neutral')
mkdirSync(neutral)

// A minimal stdio MCP server, a stand-in for the Centralu bridge and for one of the person's own servers
const mcpPath = join(root, 'mcp.mjs')
writeFileSync(
  mcpPath,
  `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
`,
)

type Ev = { at: number; n: ServerNotification }
const evs: Ev[] = []
const requests: ServerRequest[] = []
let exitedAt = 0
const t0 = Date.now()
const waiters: ((e: Ev) => void)[] = []
const client: CodexClient = new CodexClient(
  {
    onNotification: (n) => {
      const e = { at: Date.now(), n }
      evs.push(e)
      waiters.forEach((w) => w(e))
    },
    onServerRequest: (r) => {
      requests.push(r)
      client.respond(r.id, { decision: 'accept' })
    },
    onExit: () => void (exitedAt = Date.now()),
  },
  { cwd: neutral },
)
await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
client.notify('initialized')

const tp = (e: Ev) => (e.n.params ?? {}) as Record<string, any>
const serverPid = () => {
  const ps = execFileSync('ps', ['-axo', 'pid,ppid,rss,command']).toString().split('\n')
  const mine = ps.map((l) => l.trim().split(/\s+/)).filter((p) => p.length > 3)
  return { mine }
}
/** RSS in MB of the app-server's whole process tree (the npm node wrapper included) */
function treeRss(): { mb: number; procs: number; mcp: number } {
  const rows = serverPid().mine.map((p) => ({ pid: +p[0]!, ppid: +p[1]!, rss: +p[2]!, cmd: p.slice(3).join(' ') }))
  const roots = rows.filter((r) => r.ppid === process.pid && /codex/.test(r.cmd))
  const seen = new Set<number>()
  const walk = (pid: number) => {
    seen.add(pid)
    rows.filter((r) => r.ppid === pid).forEach((r) => walk(r.pid))
  }
  roots.forEach((r) => walk(r.pid))
  const inTree = rows.filter((r) => seen.has(r.pid))
  return { mb: Math.round(inTree.reduce((s, r) => s + r.rss, 0) / 1024), procs: inTree.length, mcp: inTree.filter((r) => r.cmd.includes(mcpPath)).length }
}
const rootPids = () => serverPid().mine.filter((p) => +p[1]! === process.pid && /codex/.test(p.slice(3).join(' '))).map((p) => +p[0]!)

const cwds: string[] = []
const threads: string[] = []
const mcpCfg = (withMcp: boolean) => (withMcp ? { mcp_servers: { probe_bridge: { command: process.execPath, args: [mcpPath] }, probe_person: { command: process.execPath, args: [mcpPath] } } } : {})
async function addThread(i: number, withMcp: boolean) {
  const cwd = join(root, `proj${i}`)
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'AGENTS.md'), `The project code word is PROJ${i}-WORD.\n`)
  cwds.push(cwd)
  const r = await client.request<{ thread: { id: string } }>('thread/start', {
    cwd,
    model: o.model,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: { model_reasoning_effort: 'low', shell_environment_policy: { set: { CC_PROBE_CRED: `cred-${i}` } }, ...mcpCfg(withMcp) },
  })
  threads.push(r.thread.id)
  return r.thread.id
}
const startTurn = (threadId: string, text: string) => client.request('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text }] })
const turnDone = (threadId: string, ms = 240_000) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('turn timed out ' + threadId.slice(-6))), ms)
    const check = (e: Ev) => {
      if (e.n.method === 'turn/completed' && tp(e).threadId === threadId) {
        clearTimeout(t)
        res()
      }
    }
    waiters.push(check)
  })
const textOf = (threadId: string) => evs.filter((e) => tp(e).threadId === threadId && e.n.method === 'item/completed' && tp(e).item?.type === 'agentMessage').map((e) => tp(e).item.text).join('\n')
const outputOf = (threadId: string) => evs.filter((e) => tp(e).threadId === threadId && e.n.method === 'item/completed' && tp(e).item?.type === 'commandExecution').map((e) => String(tp(e).item.aggregatedOutput ?? ''))
const gate: Record<string, unknown> = {}
const log = (g: string, v: unknown) => {
  gate[g] = v
  console.log(`GATE ${g}: ${JSON.stringify(v)}`)
}

try {
  if (!o['only-f']) {
  // (d) RSS as threads are added: without, then with two stdio MCP servers (the bridge's stand-in and a person's) per thread
  const rss: Record<string, unknown>[] = []
  rss.push({ n: 0, ...treeRss() })
  for (let i = 0; i < 10; i++) {
    await addThread(i, false)
    const n = i + 1
    if ([1, 2, 5, 10].includes(n)) rss.push({ n, kind: 'thread started, no MCP', ...treeRss() })
  }
  // A turn on each loads the thread's tools and runs its MCP servers; the first five get a shell command
  log('d_rss_without_mcp', rss)
  // (c) credential and pwd per thread; (h) cwd from the thread, not the process; (b) server requests carry threadId (see below)
  await Promise.all(
    threads.slice(0, 5).map(async (t, i) => {
      const d = turnDone(t)
      await startTurn(t, `Run the shell command: echo "CRED=$CC_PROBE_CRED PWD=$(pwd)"   Then reply with one word.`)
      await d
    }),
  )
  log('c_shell_env_and_cwd', threads.slice(0, 5).map((t, i) => ({ i, out: outputOf(t).map((s) => s.trim()), expectCred: `cred-${i}`, expectCwd: cwds[i] })))
  const turnDones = threads.slice(5, 10).map((t) => turnDone(t))
  await Promise.all(threads.slice(5, 10).map((t, k) => startTurn(t, `Without using any tool: which project code word do your project instructions (AGENTS.md) give? Answer with only the word.`)))
  await Promise.all(turnDones)
  log('h_agents_md_from_thread_cwd', threads.slice(5, 10).map((t, k) => ({ i: k + 5, answer: textOf(t).trim(), expect: `PROJ${k + 5}-WORD` })))
  log('d_rss_after_turns_no_mcp', treeRss())

  // (a) two turns at once stream independently: delta windows overlap
  const mark = evs.length
  const [a, b] = [threads[0]!, threads[1]!]
  const da = turnDone(a)
  const db = turnDone(b)
  await Promise.all([startTurn(a, 'Write the numbers 1 to 150, one per line, nothing else.'), startTurn(b, 'Write the numbers 151 to 300, one per line, nothing else.')])
  await Promise.all([da, db])
  const span = (t: string) => {
    const d = evs.slice(mark).filter((e) => tp(e).threadId === t && e.n.method === 'item/agentMessage/delta')
    return { first: d[0]!.at - t0, last: d.at(-1)!.at - t0, deltas: d.length }
  }
  const sa = span(a)
  const sb = span(b)
  log('a_two_turns_at_once', { a: sa, b: sb, overlapMs: Math.min(sa.last, sb.last) - Math.max(sa.first, sb.first), aOk: /\b150\b/.test(textOf(a)), bOk: /\b300\b/.test(textOf(b)) })

  // (b) a server request: a thread that needs approval (on-request, read-only sandbox) asks to write a file
  const rq0 = requests.length
  const tb = threads[2]!
  const dbq = turnDone(tb)
  await client.request('turn/start', { threadId: tb, effort: 'low', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text: 'Create the file approved.txt in the current directory with the text hi, using a shell command. Then reply with one word.' }] })
  await dbq
  log('b_server_requests', requests.slice(rq0).map((r) => ({ method: r.method, threadId: (r.params as any)?.threadId ?? null, expect: tb })))

  // (d) with two MCP servers per thread, 1, 2, 5, 10 more threads
  const before = treeRss()
  const mcpRows: Record<string, unknown>[] = [{ extraThreads: 0, ...before }]
  const mcpThreads: string[] = []
  for (let k = 1; k <= 10; k++) {
    const t = await addThread(100 + k, true)
    mcpThreads.push(t)
    if ([1, 2, 5, 10].includes(k)) {
      // One turn on the newest thread so its servers are started (Codex starts a thread's MCP servers with its first turn)
      const d = turnDone(t)
      await startTurn(t, 'Reply with the single word ok. Use no tool.')
      await d
      await new Promise((r) => setTimeout(r, 2000))
      mcpRows.push({ extraThreads: k, ...treeRss() })
    }
  }
  log('d_rss_with_two_mcp_per_thread', mcpRows)

  // (g) unsubscribe: memory and processes come back, thread/closed arrives; then resume works
  const preG = treeRss()
  const unsub = await Promise.all(mcpThreads.map((t) => client.request('thread/unsubscribe', { threadId: t }).catch((e: Error) => e.message)))
  await new Promise((r) => setTimeout(r, 3000))
  const closed = evs.filter((e) => e.n.method === 'thread/closed').length
  log('g_unsubscribe', { before: preG, after: treeRss(), responses: unsub.slice(0, 2), threadClosedNotifications: closed })
  const re = await client.request('thread/resume', { threadId: mcpThreads[0]!, cwd: cwds.at(-1)!, model: o.model }).then(() => 'resumed', (e: Error) => e.message)
  log('g_resume_after_unsubscribe', re)

  }
  if (o['only-f']) await addThread(0, false)
  // (f) resume of the big thread while another thread streams
  if (o.rollout) {
    copyFileSync(o.rollout, join(home, 'sessions', '2026', '01', '01', basename(o.rollout)))
    const bigId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(o.rollout)![1]!
    for (const variant of ['control', 'resume-excludeTurns', 'resume-full']) {
    const mk = evs.length
    const streamer = threads[0]!
    const ds = turnDone(streamer)
    await startTurn(streamer, 'Write the numbers 1 to 1500, one per line, nothing else.')
    await new Promise((r) => setTimeout(r, 2500))
    const rs = Date.now()
    if (variant !== 'control') await client.request('thread/unsubscribe', { threadId: bigId }).catch(() => {})
    const bigDone = (variant === 'control' ? Promise.resolve() : client.request('thread/resume', { threadId: bigId, cwd: neutral, model: o.model, ...(variant === 'resume-excludeTurns' ? { excludeTurns: true } : {}) })).then(() => Date.now())
    const re2 = await bigDone
    await ds
    const d = evs.slice(mk).filter((e) => tp(e).threadId === streamer && e.n.method === 'item/agentMessage/delta').map((e) => e.at)
    let maxGap = 0
    let gapAt = 0
    for (let i = 1; i < d.length; i++) if (d[i]! - d[i - 1]! > maxGap) ((maxGap = d[i]! - d[i - 1]!), (gapAt = d[i - 1]! - rs))
    const gapsWithin = d.filter((x) => x >= rs && x <= re2)
    const gapBaseline = (() => {
      const pre = d.filter((x) => x < rs)
      let m = 0
      for (let i = 1; i < pre.length; i++) m = Math.max(m, pre[i]! - pre[i - 1]!)
      return m
    })()
    log('f_' + variant, { resumeMs: re2 - rs, streamerDeltasDuringResume: gapsWithin.length, maxGapMs: maxGap, maxGapStartedMsAfterResumeSent: gapAt, maxGapBeforeResumeMs: gapBaseline })
    }
  }

  if (!o['only-f']) {
  // (e) kill mid-turn: what the other threads lose
  const running = threads.slice(0, 3)
  const mk2 = evs.length
  const doneBefore = new Set<string>()
  await Promise.all(running.map((t) => startTurn(t, 'Run the shell command `sleep 25` and then reply with one word.')))
  await new Promise((r) => setTimeout(r, 6000))
  const pids = rootPids()
  const tKill = Date.now()
  for (const pid of pids) process.kill(pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 3000))
  const after = evs.slice(mk2)
  log('e_kill_mid_turn', {
    killedPids: pids,
    exitReportedMsAfterKill: exitedAt ? exitedAt - tKill : null,
    turnCompletedAfterKill: after.filter((e) => e.n.method === 'turn/completed' && e.at > tKill).length,
    note: 'one process: every thread ends with it',
  })
  }
} catch (e) {
  console.log('ERROR ' + String(e))
} finally {
  try {
    await client.dispose()
  } catch {
    /* gone */
  }
  rmSync(root, { recursive: true, force: true })
}
console.log('RESULT ' + JSON.stringify(gate))
process.exit(0)
