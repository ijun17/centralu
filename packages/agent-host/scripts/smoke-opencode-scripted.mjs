/**
 * What Centralu's presets make OpenCode do, on a real host and the installed `opencode acp`, with no account and no
 * quota: OpenCode's model is a local stand-in (an OpenAI-compatible server in this script) that answers each turn with
 * scripted tool calls, so the decisions are OpenCode's own permission evaluation on this platform, not a listing
 * (docs/plans/acp-adapter.md §0.8, "How a claim here is checked"). Each case starts its own host and OpenCode with their
 * own temporary folders (CC_DATA_DIR and --db, XDG folders, HOME), writes the case's settings, sends one message, denies
 * every card, and checks the cards it got, how the turn ended and which files were written.
 *
 * It stops only the hosts it started and their `opencode acp`. Run with:
 * node packages/agent-host/scripts/smoke-opencode-scripted.mjs [case names...]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { agentProcesses, processes } from './smoke-processes.mjs'

const TOKEN = 'smoke-opencode-scripted'
const TOOL = 'opencode'
/** A turn that has not ended by then waits on something nobody answers (an ask inside a subagent, #1565 case E) */
const BOUND = 90_000
const log = (...a) => console.log('[opencode-scripted]', ...a)

const helper = '---\ndescription: Helper that runs shell commands and writes files for the user\nmode: subagent\npermission:\n  bash: allow\n  edit: allow\n---\nYou run the commands you are given.\n'
const both = { bash: 'allow', edit: 'allow' }

/**
 * Each case: the preset, the person's files (in the project, and in OpenCode's global folder), the calls the model
 * makes (`task:<agent>` starts that subagent, which makes `sub`), and what has to happen. `cards` are the tools carded;
 * `written` the files that exist after (`marker.txt` from the command, `w.txt` from the write tool)
 */
const CASES = [
  { name: 'safe', preset: 'safe', calls: ['bash', 'write'], cards: ['bash', 'write'], written: [] },
  { name: 'normal', preset: 'normal', calls: ['bash', 'write'], cards: ['bash', 'write'], written: [] },
  { name: 'edits', preset: 'edits', calls: ['bash', 'write'], cards: ['bash'], written: ['w.txt'] },
  { name: 'C mode.build in the project', preset: 'safe', project: { 'opencode.json': { mode: { build: { permission: both } } } }, calls: ['bash', 'write'], cards: ['bash', 'write'], written: [] },
  { name: 'D mode.build in the global settings', preset: 'safe', global: { 'opencode.json': { mode: { build: { permission: both } } } }, calls: ['bash', 'write'], cards: ['bash', 'write'], written: [] },
  { name: 'G agent.build allows everything', preset: 'safe', project: { 'opencode.json': { agent: { build: { permission: { ...both, '*': 'allow' } } } } }, calls: ['bash', 'write'], cards: ['bash', 'write'], written: [] },
  { name: 'J webfetch', preset: 'safe', calls: ['webfetch'], cards: ['webfetch'], written: [] },
  { name: "the person's bash deny", preset: 'safe', project: { 'opencode.json': { permission: { bash: 'deny' } } }, calls: ['bash', 'write'], cards: ['write'], written: [] },
  { name: 'E a subagent of their own', preset: 'safe', project: { '.opencode/agent/helper.md': helper }, calls: ['task:helper'], sub: ['bash', 'write'], cards: [], written: [] },
  { name: 'E the general subagent', preset: 'safe', calls: ['task:general'], sub: ['bash'], cards: [], written: [] },
  { name: 'E the general subagent, Normal', preset: 'normal', calls: ['task:general'], sub: ['bash'], cards: [], written: [] },
  { name: "Normal keeps the person's allow", preset: 'normal', project: { 'opencode.json': { permission: { bash: 'allow' } } }, calls: ['bash'], cards: [], written: ['marker.txt'] },
]

const only = process.argv.slice(2)
const cases = CASES.filter((c) => !only.length || only.some((o) => c.name.startsWith(o)))

/** The tool calls a scripted step makes, as OpenCode 1.19.4's tools take them */
function callsOf(names, cwd) {
  return names.map((n, i) => {
    const id = `call_${Date.now()}_${i}`
    if (n === 'bash') return { id, name: 'bash', args: { command: 'echo scripted > marker.txt', description: 'Write marker' } }
    if (n === 'write') return { id, name: 'write', args: { filePath: join(cwd, 'w.txt'), content: 'hi' } }
    if (n === 'webfetch') return { id, name: 'webfetch', args: { url: 'https://example.com', format: 'text' } }
    if (n.startsWith('task:')) return { id, name: 'task', args: { description: 'Run it', prompt: 'SUBTASK: run the command and write the file', subagent_type: n.slice(5) } }
    throw new Error(`no scripted call ${n}`)
  })
}

/**
 * The stand-in model: a request with tools and no tool result yet gets the case's calls (the subagent's, when its first
 * message is the task's prompt), every other request a line of text. Streams as OpenAI's chat completions do
 */
function fakeModel(c, cwd) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const j = JSON.parse(body || '{}')
      const msgs = j.messages ?? []
      const text = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(''))
      const firstUser = msgs.find((m) => m.role === 'user')
      const sub = !!firstUser && text(firstUser).includes('SUBTASK')
      const answered = msgs.some((m) => m.role === 'tool')
      const calls = j.tools?.length && !answered ? callsOf(sub ? (c.sub ?? []) : c.calls, cwd) : []
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices, ...extra })}\n\n`)
      if (calls.length) {
        chunk([{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((x, index) => ({ index, id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.args) } })) }, finish_reason: null }])
        chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }])
      } else {
        chunk([{ index: 0, delta: { role: 'assistant', content: sub ? 'helper done' : 'done' }, finish_reason: null }])
        chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
      }
      chunk([], { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

const put = (base, files = {}) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true })
    writeFileSync(join(base, rel), typeof body === 'string' ? body : JSON.stringify(body))
  }
}

/** The hosts this run started: a run that fails part way stops them, and their agents, as it exits */
const hosts = []
const ours = new Set()
process.on('exit', () => {
  for (const host of hosts) {
    const agents = acpPidsOf(host.pid)
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL')
    stop(agents)
  }
})

const stop = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(Number(pid))
    } catch {
      /* already gone */
    }
  }
}

/** The `opencode acp` processes of this run still running: a host's descendants, read while it runs, and those seen before */
function acpPidsOf(hostPid) {
  const all = processes()
  const tree = new Set([String(hostPid)])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) (tree.add(p.pid), (grew = true))
  }
  for (const p of agentProcesses(all, (cmd) => /opencode/i.test(cmd) && /\bacp\b/.test(cmd))) if (tree.has(p.pid)) ours.add(p.pid)
  const alive = new Set(all.map((p) => p.pid))
  return [...ours].filter((pid) => alive.has(pid))
}

function startHost(env, db) {
  const host = spawn(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', '0', '--token', TOKEN, '--db', db], { stdio: ['ignore', 'pipe', 'inherit'], env })
  hosts.push(host)
  return new Promise((resolve, reject) => {
    host.on('exit', (code) => reject(new Error(`host exited before ready (${code})`)))
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        try {
          const j = JSON.parse(line)
          if (j.ready) resolve({ host, port: j.port })
        } catch {
          /* a log line */
        }
      }
    })
  })
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  const listeners = []
  let id = 0
  let helloOk = () => {}
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.kind === 'res') {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc failure'))
    } else if (m.kind === 'event') {
      events.push(m.event)
      for (const l of listeners) l(m.event)
    } else if (m.kind === 'hello_ok') helloOk()
  })
  const ready = new Promise((resolve) => {
    helloOk = resolve
    ws.once('open', () => ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 })))
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = String(++id)
      pending.set(rid, { resolve, reject })
      ws.send(JSON.stringify({ kind: 'rpc', id: rid, method, params }))
    })
  return { ws, call, events, ready, on: (l) => listeners.push(l) }
}

/** Which scripted tool a card is for, read from what it names */
const toolOfCard = (card) => {
  const said = JSON.stringify(card.detail ?? card)
  if (/marker\.txt/.test(said)) return 'bash'
  if (/w\.txt/.test(said)) return 'write'
  if (/example\.com/.test(said)) return 'webfetch'
  return `other: ${said.slice(0, 80)}`
}

async function run(c) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-opencode-scripted-')))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(home, { recursive: true })
  put(cwd, c.project)
  const xdg = Object.fromEntries(['CONFIG', 'DATA', 'STATE', 'CACHE'].map((k) => [`XDG_${k}_HOME`, join(root, 'xdg', k.toLowerCase())]))
  for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true })
  const model = await fakeModel(c, cwd)
  put(join(xdg.XDG_CONFIG_HOME, 'opencode'), {
    ...c.global,
    'config.json': {
      model: 'scripted/m',
      small_model: 'scripted/m',
      provider: { scripted: { npm: '@ai-sdk/openai-compatible', name: 'scripted', options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'none' }, models: { m: { name: 'm', tool_call: true } } } },
    },
  })
  // Nothing of the person's: no settings of theirs (a temporary HOME and XDG folders, no managed folder, none of the
  // settings OpenCode reads from the environment) and no data folder of Centralu's
  const env = { ...process.env, ...xdg, HOME: home, USERPROFILE: home, CC_DATA_DIR: join(root, 'data'), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed') }
  for (const k of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']) delete env[k]
  mkdirSync(env.CC_DATA_DIR, { recursive: true })

  const { host, port } = await startHost(env, join(env.CC_DATA_DIR, 'store.db'))
  const client = connect(port)
  await client.ready
  const project = await client.call('projects.add', { path: cwd })
  await client.call('projects.setTrusted', { projectId: project.id, trusted: true })
  const cards = []
  let sessionId = null
  let seen = () => {}
  // Events that come before createSession answers wait in `client.events` and are read once the session's id is known
  const turnEnd = new Promise((resolve) => {
    seen = (e) => {
      if (e.sessionId !== sessionId) return
      if (e.type === 'approval_request') {
        cards.push(toolOfCard(e))
        client.call('agents.respondApproval', { sessionId, requestId: e.requestId, decision: 'deny' }).catch(() => {})
      } else if (e.type === 'turn_complete') resolve('ended')
    }
    setTimeout(() => resolve('no end'), BOUND)
  })
  client.on((e) => sessionId && seen(e))
  const session = await client.call('agents.createSession', { projectId: project.id, cwd, tool: TOOL, permissionPreset: c.preset, initialPrompt: 'go' })
  sessionId = session.id
  for (const e of [...client.events]) seen(e)
  const ended = await turnEnd
  acpPidsOf(host.pid)
  host.kill('SIGTERM')
  await new Promise((r) => (host.exitCode !== null || host.signalCode !== null ? r() : host.once('exit', r)))
  const left = acpPidsOf(host.pid)
  stop(left)
  model.server.close()
  client.ws.close()

  const written = ['marker.txt', 'w.txt'].filter((f) => existsSync(join(cwd, f)))
  const sorted = (a) => [...a].sort().join(',') || 'none'
  const problems = [
    ended === 'ended' ? null : `the turn did not end in ${BOUND / 1000} s`,
    sorted(cards) === sorted(c.cards) ? null : `cards ${sorted(cards)}, expected ${sorted(c.cards)}`,
    sorted(written) === sorted(c.written) ? null : `written ${sorted(written)}, expected ${sorted(c.written)}`,
    left.length ? `${left.length} agent process left after the host stopped` : null,
  ].filter(Boolean)
  log(`${problems.length ? 'FAIL' : 'PASS'} ${c.name} (${c.preset}): cards ${sorted(cards)}, written ${sorted(written)}${problems.length ? ' - ' + problems.join('; ') : ''}`)
  return problems.length === 0
}

let failures = 0
for (const c of cases) if (!(await run(c))) failures++
log(failures === 0 ? `all ${cases.length} passed` : `${failures} of ${cases.length} failed`, `on ${process.platform}`)
process.exit(failures === 0 ? 0 : 1)
