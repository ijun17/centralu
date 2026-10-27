#!/usr/bin/env -S npx tsx
/**
 * Records real Antigravity CLI (`agy`) runs for the adapter's tests (docs/plans/antigravity-adapter.md §10, #1498).
 *
 *   pnpm exec tsx scripts/agy-record.mts --out <raw folder> [--model gemini-3.8-flash-low] [scenario ...]
 *   pnpm exec tsx scripts/agy-record.mts --list
 *
 * Each scenario spawns the installed `agy` the way the adapter does (§3.1: stream-json in and out, the skip flag, a
 * per-run plugin root passed with `--add-dir` whose `PreToolUse` hook is the real `agy-gate.mjs`), in a temporary
 * working folder, writes scripted input lines and answers the gate from a small HTTP listener standing in for the host.
 * Every line is written raw, with its time, to `<out>/<scenario>.raw.jsonl`:
 *
 *   {t, dir: 'out', line}       a line written to agy's stdin
 *   {t, dir: 'in', line}        a line agy printed on stdout
 *   {t, dir: 'err', line}       a line agy printed on stderr
 *   {t, dir: 'gate', msg}       a hook request the gate got and the answer it gave: {input, output}
 *   {t, dir: 'note', msg}       what the recorder did or checked itself (a signal it sent, whether a command ran)
 *   {t, dir: 'exit', msg}       how the process ended: {code, sig}
 *   {t, dir: 'spawn', msg}      a process started: {args} (several per scenario when one resumes another)
 *
 * The raw files hold this machine's paths and ids; `scripts/agy-scrub.mts` turns them into fixtures.
 *
 * It spends the person's own `agy` quota (a few short turns per scenario, on the cheapest model) and writes to `agy`'s
 * own state folder, as every `agy` run does (§1.8). Nothing is written to the person's `agy` config or to a repository.
 * Run it by hand before an `agy` bump, never on a schedule. It runs on macOS and Linux: its hook commands are `sh`'s.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalDecision, ApprovalDetail, NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { agyMcpDescriptors, parseRule } from '../packages/agent-host/src/adapters/agy/deny-rules.ts'
import { AgyGate, stopTurn } from '../packages/agent-host/src/adapters/agy/gate.ts'
import { removePluginRoot, writePluginRoot } from '../packages/agent-host/src/adapters/agy/plugin-root.ts'
import { agyGatePaths } from '../packages/agent-host/src/adapters/bridge-path.ts'
import * as fsp from 'node:fs/promises'

const GATE_SCRIPT = fileURLToPath(new URL('../packages/agent-host/src/adapters/agy/agy-gate.mjs', import.meta.url))

type Frame = Record<string, unknown>
type GateAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string } | { hold: Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string }> }
type GateHandler = (input: Frame) => GateAnswer | Promise<GateAnswer>

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const MODEL = arg('model') ?? 'gemini-3.8-flash-low'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** One scenario's run: its folders, the gate listener, the file it writes, the processes it starts */
class Run {
  readonly cwd: string
  pluginRoot: string
  readonly file: string
  private readonly start = Date.now()
  private server: Server | null = null
  gateUrl = ''
  readonly gateToken = randomBytes(18).toString('base64url')
  onGate: GateHandler = () => ({ decision: 'allow' })
  readonly gateInputs: Frame[] = []
  readonly procs: Proc[] = []
  /** The host's gate (`gate.ts`) when the scenario runs on it, with the plugin root `plugin-root.ts` writes */
  hostGate: AgyGate | null = null
  private gateData: string | null = null

  constructor(
    readonly scenario: string,
    out: string,
    hookCommand?: (gate: string) => string,
    hookTimeoutS = 900,
  ) {
    this.cwd = mkdtempSync(join(tmpdir(), 'agy-rec-cwd-'))
    this.pluginRoot = mkdtempSync(join(tmpdir(), 'agy-rec-plugin-'))
    this.file = join(out, `${scenario}.raw.jsonl`)
    writeFileSync(this.file, '')
    const plugin = join(this.pluginRoot, '.agents', 'plugins', 'centralu')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'centralu' }))
    const command = hookCommand ? hookCommand(GATE_SCRIPT) : `${q(process.execPath)} ${q(GATE_SCRIPT)}`
    writeFileSync(
      join(plugin, 'hooks.json'),
      JSON.stringify({ 'centralu-gate': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: hookTimeoutS }] }] } }, null, 2),
    )
  }

  /**
   * Runs this scenario on the host's own gate and plugin root (`gate.ts`, `plugin-root.ts`): the plugin root is written
   * the way a session's is, under a temporary data folder, and every hook request is answered by `AgyGate`. Each card it
   * raises is noted and answered by `person`, or left open when that returns null.
   */
  async useGate(opts: { preset: PermissionPreset; denyRules?: string[]; person?: (detail: ApprovalDetail) => ApprovalDecision | null; fakeCentralu?: boolean }): Promise<void> {
    rmSync(this.pluginRoot, { recursive: true, force: true })
    this.gateData = mkdtempSync(join(tmpdir(), 'agy-rec-data-'))
    const bridge = opts.fakeCentralu ? join(this.gateData, 'fake-centralu-mcp.mjs') : undefined
    if (bridge) writeFileSync(bridge, FAKE_MCP)
    this.pluginRoot = await writePluginRoot({ dataDir: this.gateData, sessionId: 'rec', node: process.execPath, gateSources: agyGatePaths(), files: fsp, ...(bridge ? { bridge } : {}) })
    const gate = new AgyGate({
      sessionId: 'rec',
      cwd: this.cwd,
      pluginRoot: this.pluginRoot,
      preset: opts.preset,
      denyRules: (opts.denyRules ?? []).flatMap((t) => parseRule(t) ?? []),
      mcpDescriptors: agyMcpDescriptors(homedir()),
      emit: (e: NormalizedEvent) => {
        if (e.type === 'approval_request') {
          this.write('card', { msg: { requestId: e.requestId, detail: e.detail } })
          const decision = opts.person?.(e.detail) ?? null
          if (decision) setTimeout(() => gate.respondApproval(e.requestId, decision), 300)
        } else if (e.type === 'approval_resolved') this.write('card', { msg: { requestId: e.requestId, resolved: e.decision } })
      },
    })
    this.hostGate = gate
    this.onGate = (input) => gate.answer(input)
  }

  write(dir: string, entry: Frame): void {
    appendFileSync(this.file, `${JSON.stringify({ t: Date.now() - this.start, dir, ...entry })}\n`)
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.gate(req).then((out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out)), () => res.writeHead(500).end()))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    const addr = this.server.address()
    this.gateUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/gate`
  }

  private async gate(req: IncomingMessage): Promise<Frame> {
    if (req.headers.authorization !== `Bearer ${this.gateToken}`) throw new Error('bad credential')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Frame
    this.gateInputs.push(input)
    let answer = await this.onGate(input)
    if ('hold' in answer) answer = await answer.hold
    this.write('gate', { msg: { input, output: answer } })
    return answer
  }

  spawn(opts: { resume?: string; home?: string; extra?: string[]; args?: string[] } = {}): Proc {
    const args = opts.args ?? [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', MODEL,
      '--dangerously-skip-permissions',
      '--add-dir', this.pluginRoot,
      ...(opts.resume ? ['--conversation', opts.resume] : []),
      ...(opts.extra ?? []),
      '-p=',
    ]
    this.write('spawn', { msg: { args } })
    const env = { ...process.env, CC_AGY_GATE_URL: this.gateUrl, CC_AGY_GATE_TOKEN: this.gateToken, ...(opts.home ? { HOME: opts.home } : {}) }
    const child = spawn('agy', args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const proc = new Proc(child, this)
    this.procs.push(proc)
    return proc
  }

  close(): void {
    // Only the processes this run started, should a scenario fail with one still running
    for (const p of this.procs) if (!p.done) p.child.kill('SIGKILL')
    // A held gate request or a kept-alive connection would keep the listener, and so this script, alive
    this.server?.closeAllConnections()
    this.server?.close()
    rmSync(this.cwd, { recursive: true, force: true })
    if (this.gateData) {
      const data = this.gateData
      void removePluginRoot(fsp, data, 'rec')
        .then(() => rmSync(data, { recursive: true, force: true }))
        .catch((e: unknown) => console.error(`could not remove ${data}: ${String(e)}`))
    } else rmSync(this.pluginRoot, { recursive: true, force: true })
  }
}

class Proc {
  readonly frames: Frame[] = []
  readonly stderr: string[] = []
  private waiters: { test: () => boolean; resolve: () => void }[] = []
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  done = false

  constructor(
    readonly child: ChildProcess,
    private readonly run: Run,
  ) {
    const lines = (stream: NodeJS.ReadableStream, each: (line: string) => void) => {
      let buf = ''
      stream.on('data', (d: Buffer) => {
        buf += String(d)
        let n
        while ((n = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, n)
          buf = buf.slice(n + 1)
          if (line.trim()) each(line)
        }
      })
    }
    lines(child.stdout!, (line) => {
      run.write('in', { line })
      try {
        this.frames.push(JSON.parse(line) as Frame)
      } catch {
        this.frames.push({ unparsed: line })
      }
      this.check()
    })
    lines(child.stderr!, (line) => {
      run.write('err', { line })
      this.stderr.push(line)
      this.check()
    })
    this.exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        run.write('exit', { msg: { code, sig: signal } })
        this.done = true
        this.check()
        resolve({ code, signal })
      }),
    )
  }

  private check(): void {
    this.waiters = this.waiters.filter((w) => (w.test() ? (w.resolve(), false) : true))
  }

  send(text: string): void {
    const line = JSON.stringify({ event: 'user', message: { content: text } })
    this.run.write('out', { line })
    this.child.stdin!.write(`${line}\n`)
  }

  /**
   * Resolves when `test` holds over what was seen so far; fails after `ms`. Checked on every line and every 100 ms, since
   * some tests read what the gate saw, which no line follows while the request is held.
   */
  until(what: string, test: () => boolean, ms = 120_000): Promise<void> {
    if (test()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => (clearTimeout(timer), clearInterval(poll))
      const timer = setTimeout(() => (done(), reject(new Error(`${this.run.scenario}: timed out waiting for ${what}`))), ms)
      const poll = setInterval(() => test() && (done(), resolve()), 100)
      this.waiters.push({ test, resolve: () => (done(), resolve()) })
    })
  }

  results(): number {
    return this.frames.filter((f) => f.event === 'result').length
  }

  untilResults(n: number, ms?: number): Promise<void> {
    return this.until(`${n} result(s)`, () => this.results() >= n || this.done, ms)
  }

  conversationId(): string | undefined {
    const init = this.frames.find((f) => f.event === 'init') as { conversation_id?: string } | undefined
    return init?.conversation_id
  }

  async closeAndWait(): Promise<void> {
    this.child.stdin!.end()
    await this.exited
  }
}

/** A stdio MCP server standing in for Centralu's bridge: one tool, `ping`, answering `pong` */
const FAKE_MCP = `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'centralu', version: '0' } } })
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Answers pong', inputSchema: { type: 'object', properties: {} } }] } })
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
})
`

type Scenario = { name: string; what: string; hook?: (gate: string) => string; hookTimeoutS?: number; run: (r: Run) => Promise<void> }

const allowAll: GateHandler = () => ({ decision: 'allow' })
const isCommand = (input: Frame) => (input.toolCall as { name?: string } | undefined)?.name === 'run_command'

const SCENARIOS: Scenario[] = [
  {
    name: 'basic',
    what: 'a plain turn with no tool',
    run: async (r) => {
      const p = r.spawn()
      p.send('Reply with exactly the single word: pineapple. Do not use any tool.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'tool',
    what: 'a command the gate allows',
    run: async (r) => {
      r.onGate = allowAll
      const p = r.spawn()
      p.send('Run the shell command `echo gate-ok` with your command tool, then reply with its output only.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'edit',
    what: 'a file written in the working folder, the gate allowing',
    run: async (r) => {
      r.onGate = allowAll
      const p = r.spawn()
      p.send('Create a file named notes.txt in the current folder containing the single line `hello`. Then reply with: done.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'gate-deny',
    what: 'a command the gate denies: the model is told and continues',
    run: async (r) => {
      r.onGate = (input) => (isCommand(input) ? { decision: 'deny', reason: 'The person declined.' } : { decision: 'allow' })
      const p = r.spawn()
      p.send('Run the shell command `echo denied-check` with your command tool. If it is refused, reply with: refused.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'gate-twice',
    what: 'the same command twice, both allowed (the host decides the second without a card under an always rule)',
    run: async (r) => {
      r.onGate = allowAll
      const p = r.spawn()
      p.send('Run the shell command `echo again` twice, as two separate command tool calls one after the other. Then reply with: twice.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'subagent',
    what: "a sub-agent started, its own command passing the parent's gate, and its report",
    run: async (r) => {
      r.onGate = allowAll
      const p = r.spawn()
      p.send(
        'Use your invoke_subagent tool to start one sub-agent with this task: "Run the shell command `echo from-child` and send the output back to your parent." Wait for its message, then reply with the output it sent.',
      )
      await p.untilResults(1, 240_000)
      await p.closeAndWait()
    },
  },
  {
    name: 'queued',
    what: 'a second input the host held until the first turn ended',
    run: async (r) => {
      const p = r.spawn()
      p.send('Reply with exactly the single word: first. Do not use any tool.')
      await p.untilResults(1)
      p.send('Reply with exactly the single word: second. Do not use any tool.')
      await p.untilResults(2)
      await p.closeAndWait()
    },
  },
  {
    name: 'interrupt',
    what: 'SIGINT while the answer streams, then the next input in a new process with --conversation',
    run: async (r) => {
      const p = r.spawn()
      p.send('Count from 1 to 200, one number per line, no other text. Do not use any tool.')
      await p.until('text', () => p.frames.some((f) => (f.step_update as { text_delta?: string } | undefined)?.text_delta))
      p.child.kill('SIGINT')
      await p.exited
      const id = p.conversationId()
      const next = r.spawn({ resume: id })
      next.send('Reply with exactly the single word: resumed. Do not use any tool.')
      await next.untilResults(1)
      await next.closeAndWait()
    },
  },
  {
    name: 'interrupt-gate',
    what: 'a Stop while a gate request waits for the person: the open request is answered deny, then SIGINT (§1.5)',
    run: async (r) => {
      let release: (a: { decision: 'deny'; reason: string }) => void = () => {}
      let asked = false
      r.onGate = (input) => {
        if (!isCommand(input)) return { decision: 'allow' }
        asked = true
        return { hold: new Promise((res) => (release = res)) }
      }
      const p = r.spawn()
      p.send('Run the shell command `echo held` with your command tool, then reply with its output only.')
      await p.until('a gate request', () => asked)
      await sleep(500)
      // What the adapter does on a Stop: every open gate request is answered deny first, since agy does not act on
      // SIGINT while a hook runs (measured: it waited for the hook)
      release({ decision: 'deny', reason: 'The turn was stopped.' })
      r.write('note', { msg: { sent: 'SIGINT', after: 'the open gate request was answered deny' } })
      p.child.kill('SIGINT')
      await Promise.race([p.exited, sleep(30_000)])
      r.write('note', { msg: { endedWithin30s: p.done } })
    },
  },
  {
    name: 'die',
    what: 'SIGKILL mid-turn, then --conversation in a new process',
    run: async (r) => {
      const first = r.spawn()
      first.send('Remember the word "tangerine". Reply with exactly: noted. Do not use any tool.')
      await first.untilResults(1)
      first.send('Count from 1 to 200, one number per line, no other text. Do not use any tool.')
      await first.until('text', () => first.frames.filter((f) => (f.step_update as { text_delta?: string } | undefined)?.text_delta).length > 1)
      first.child.kill('SIGKILL')
      await first.exited
      const next = r.spawn({ resume: first.conversationId() })
      next.send('Which word did I ask you to remember? Reply with that word only. Do not use any tool.')
      await next.untilResults(1)
      await next.closeAndWait()
    },
  },
  {
    name: 'unknown-id',
    what: 'an unknown --conversation id: agy warns and starts a new conversation; stopped at its init, as the adapter does',
    run: async (r) => {
      const p = r.spawn({ resume: '00000000-0000-4000-8000-000000000000' })
      p.send('Reply with exactly the single word: lost. Do not use any tool.')
      await p.until('init', () => p.conversationId() !== undefined || p.done)
      r.write('note', { msg: { sent: 'SIGINT', at: 'init' } })
      p.child.kill('SIGINT')
      await p.exited
    },
  },
  {
    name: 'logged-out',
    what: 'no login (a temporary home): the first input fails, no turn',
    run: async (r) => {
      const home = mkdtempSync(join(tmpdir(), 'agy-rec-home-'))
      try {
        const p = r.spawn({ home })
        p.send('Reply with exactly the single word: hello.')
        await Promise.race([p.exited, sleep(30_000)])
        if (!p.done) await p.closeAndWait()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'commands',
    what: 'the read-only commands: /usage, /model, /effort, and agy models; no turn',
    run: async (r) => {
      for (const args of [['-p', '/usage', '--output-format', 'json'], ['-p', '/model', '--output-format', 'json'], ['-p', '/effort', '--output-format', 'json'], ['models']]) {
        const p = r.spawn({ args })
        p.child.stdin!.end()
        await p.exited
      }
    },
  },
  // The host's gate (`gate.ts`) and plugin root (`plugin-root.ts`) with a real agy, one scenario per preset (§5.2)
  {
    name: 'preset-auto',
    what: 'auto on the host gate: a command, a write and a read, all without a card',
    run: async (r) => {
      await r.useGate({ preset: 'auto' })
      const p = r.spawn()
      p.send('Do these one at a time, each with its own tool call: 1) run the shell command `echo p-auto` 2) create the file notes.txt in the current folder containing `hi` 3) read notes.txt. Then reply with: done.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'preset-edits',
    what: 'edits on the host gate: a write inside the folder without a card, a command with a card the person allows',
    run: async (r) => {
      await r.useGate({ preset: 'edits', person: () => 'allow' })
      const p = r.spawn()
      p.send('Do these one at a time, each with its own tool call: 1) create the file notes.txt in the current folder containing `hi` 2) run the shell command `echo p-edits`. Then reply with: done.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'preset-normal',
    what: 'normal on the host gate: a read inside the folder without a card, a write the person denies, a command the person allows',
    run: async (r) => {
      writeFileSync(join(r.cwd, 'readme.txt'), 'normal-read\n')
      await r.useGate({ preset: 'normal', person: (d) => (d.kind === 'file_edit' ? 'deny' : 'allow') })
      const p = r.spawn()
      p.send('Do these one at a time, each with its own tool call, and go on if one is refused: 1) read the file readme.txt 2) create the file notes.txt containing `hi` 3) run the shell command `echo p-normal`. Then reply with which steps were refused.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'preset-safe',
    what: "safe on the host gate: a read inside the folder and Centralu's own MCP tool without a card, a command the person denies",
    run: async (r) => {
      writeFileSync(join(r.cwd, 'readme.txt'), 'safe-read\n')
      await r.useGate({ preset: 'safe', person: () => 'deny', fakeCentralu: true })
      const p = r.spawn()
      p.send('Do these one at a time, each with its own tool call, and go on if one is refused: 1) read the file readme.txt 2) call the `ping` tool of the MCP server whose name starts with centralu 3) run the shell command `echo p-safe`. Then reply with which steps were refused.')
      await p.untilResults(1, 180_000)
      await p.closeAndWait()
    },
  },
  {
    name: 'deny-rule',
    what: "the person's agy deny rule on the host gate under auto: the matching command refused, the other run",
    run: async (r) => {
      await r.useGate({ preset: 'auto', denyRules: ['command(echo deny-me)'] })
      const p = r.spawn()
      p.send('Do these one at a time, each with its own tool call, and go on if one is refused: 1) run the shell command `echo ok; echo deny-me` 2) run the shell command `echo allowed-one`. Then reply with which steps were refused and the exact reason.')
      await p.untilResults(1)
      await p.closeAndWait()
    },
  },
  {
    name: 'stop-card',
    what: 'a Stop with a card open on the host gate: stopTurn denies it, then SIGINT; the process ends within seconds',
    run: async (r) => {
      await r.useGate({ preset: 'normal', person: () => null })
      const p = r.spawn()
      p.send('Run the shell command `echo held` with your command tool, then reply with its output only.')
      await p.until('a card', () => (r.hostGate?.open ?? 0) > 0)
      await sleep(500)
      const at = Date.now()
      stopTurn(r.hostGate!, () => p.child.kill('SIGINT'))
      r.write('note', { msg: { sent: 'SIGINT', after: 'stopTurn answered the open card deny' } })
      await Promise.race([p.exited, sleep(30_000)])
      r.write('note', { msg: { endedWithin30s: p.done, ms: Date.now() - at } })
      console.log(`stop-card: ${p.done ? `ended ${Date.now() - at} ms after the Stop` : 'STILL RUNNING after 30 s'}`)
    },
  },
  // How agy treats a hook that does not answer as asked (§5.4, open question 2): each must not let the command run
  ...(
    [
      ['hook-timeout', 'the hook outlives its timeout', (_g: string) => 'sleep 30', 3],
      ['hook-exit', 'the hook exits 1 with nothing on stdout', (_g: string) => 'exit 1', 30],
      ['hook-exit-allow', 'the hook prints allow but exits 1', (_g: string) => `printf '{"decision":"allow"}'; exit 1`, 30],
      ['hook-bad-json', 'the hook prints something that is not JSON', (_g: string) => 'echo not-json', 30],
      ['hook-empty', 'the hook prints nothing and exits 0', (_g: string) => 'true', 30],
      ['hook-no-decision', 'the hook prints a JSON object without a decision', (_g: string) => `printf '{}'`, 30],
      ['hook-unknown', 'the hook prints a decision agy does not know', (_g: string) => `printf '{"decision":"maybe"}'`, 30],
    ] as const
  ).map(
    ([name, what, hook, hookTimeoutS]): Scenario => ({
      name,
      what,
      hook,
      hookTimeoutS,
      run: async (r) => {
        const marker = join(r.cwd, 'ran.txt')
        const p = r.spawn()
        p.send(`Run exactly this shell command with your command tool: touch ${marker} . Then reply with: finished.`)
        await p.untilResults(1, 180_000)
        await p.closeAndWait()
        const ran = await import('node:fs').then((fs) => fs.existsSync(marker))
        r.write('note', { msg: { commandRan: ran } })
        console.log(`${name}: the command ${ran ? 'RAN' : 'did not run'}`)
      },
    }),
  ),
]

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(16)} ${s.what}`)
    return
  }
  const out = arg('out')
  if (!out) {
    console.error('usage: agy-record.mts --out <raw folder> [--model <id>] [scenario ...]')
    process.exit(2)
  }
  mkdirSync(out, { recursive: true })
  const named = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
  const chosen = named.length ? SCENARIOS.filter((s) => named.includes(s.name)) : SCENARIOS
  for (const s of chosen) {
    const r = new Run(s.name, out, s.hook, s.hookTimeoutS)
    await r.listen()
    r.write('header', { msg: { scenario: s.name, what: s.what, model: MODEL } })
    const started = Date.now()
    try {
      await s.run(r)
      console.log(`${s.name}: recorded in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    } catch (e) {
      console.error(`${s.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      r.close()
    }
  }
}

await main()
// Every run closed its own processes and listener; nothing else of this script's should be left to wait for
process.exit(0)
