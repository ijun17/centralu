#!/usr/bin/env -S npx tsx
/**
 * Records what Codex or Claude Code really sends and receives for Centralu's own tools (`mail`, `start_agent`, `agent_session`,
 * `ask_project`, `read_session`, `compact_self`), which only a real host can serve (#1498):
 *
 *   pnpm exec tsx scripts/frames-record-host.mts [codex | claude] [scenario ...] [--raw <folder>]
 *
 * It starts the agent host from source (`packages/agent-host/src/main.ts`) in a temporary data folder, with the frame recorder
 * on (`CC_RECORD_FRAMES`) and a settings folder of the tool's own (`frames-record-kit.mts`), and drives it over its WebSocket as a
 * window does: adds a project, creates sessions, sends the scenario's prompts. The session's process is started by the
 * host with Centralu's real tools (Codex: the bridge; Claude Code: served in the host's own process), so the tool calls go the whole
 * way, host included; the recording holds the lines between the host and that process, scrubbed into
 * `adapters/<codex | claude>/recordings/<tool>-<version>/<scenario>.jsonl`, which `<tool>/centralu.test.ts` replays through the
 * adapter. It spends model calls (the tool's smallest model; the sessions the scenario starts use it too) and never touches the person's data folder: `CC_DATA_DIR` and `--db` are temporary.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeDir, temporaryClaudeConfig, temporaryCodexHome } from './frames-record-kit.mts'
import { scrub } from './frames-scrub.mts'
import { CENTRALU_SCENARIOS } from '../packages/agent-host/src/adapters/codex/centralu-scenarios.test-helpers.js'
import { CLAUDE_CENTRALU_SCENARIOS } from '../packages/agent-host/src/adapters/claude/centralu-scenarios.test-helpers.js'
import type { HostScenario } from '../packages/agent-host/src/adapters/frames/host-scenario.test-helpers.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPTERS = join(ROOT, 'packages/agent-host/src/adapters')

/** What a recording differs in by tool: the cheapest model, the effort, the scenarios, and the recordings' folder prefix */
const TOOLS = {
  codex: { prefix: 'codex', model: 'gpt-5.6-luna', effort: 'low' as string | undefined, scenarios: CENTRALU_SCENARIOS as readonly HostScenario[] },
  claude: { prefix: 'claude-code', model: 'haiku', effort: undefined as string | undefined, scenarios: CLAUDE_CENTRALU_SCENARIOS },
}

type Event = { type: string; sessionId?: string; [k: string]: unknown }

/** A window's connection to the host: hello, calls, and the events it pushes */
class Window {
  readonly events: Event[] = []
  private socket!: WebSocket
  private nextId = 1
  private readonly pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
  private readonly listeners = new Set<(e: Event) => void>()

  /** The cards a scenario expects (by kind); any other is refused and fails the run */
  expected: readonly string[] = []
  /** Cards the scenario did not expect, for the run to fail with */
  readonly unexpected: string[] = []

  private card(e: Event): void {
    const kind = String((e as { detail?: { kind?: string } }).detail?.kind)
    const allow = this.expected.includes(kind)
    if (!allow) this.unexpected.push(kind)
    console.error(`[record] ${allow ? 'allowed' : 'refused'} a card of ${kind}`)
    this.rpc('agents.respondApproval', { sessionId: e.sessionId, requestId: (e as { requestId?: string }).requestId, decision: allow ? 'allow' : 'deny' }).catch((err: Error) => console.error(`[record] the host refused the answer to the card: ${err.message}`))
  }

  async open(port: number, token: string): Promise<void> {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('error', () => reject(new Error('the host did not accept the connection')))
      this.socket.addEventListener('open', () => this.socket.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 })))
      this.socket.addEventListener('message', (m) => {
        const f = JSON.parse(String(m.data)) as { kind: string; id?: string; ok?: boolean; result?: unknown; error?: { message?: string }; event?: Event }
        if (f.kind === 'hello_ok') resolve()
        else if (f.kind === 'res' && f.id) {
          const p = this.pending.get(f.id)
          this.pending.delete(f.id)
          if (f.ok) p?.resolve(f.result)
          else p?.reject(new Error(f.error?.message ?? 'host error'))
        } else if (f.kind === 'event' && f.event) {
          this.events.push(f.event)
          // A card a session raises (a tool that reaches another project asks the person first) is allowed: a recording needs the call to go through
          if (f.event.type === 'approval_request') this.card(f.event)
          for (const l of this.listeners) l(f.event)
        }
      })
    })
  }

  rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = String(this.nextId++)
    this.socket.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }

  /** The next event, from now on, that `pick` accepts; rejects after `ms` */
  waitFor(label: string, pick: (e: Event) => boolean, ms = 300_000): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(on)
        reject(new Error(`no ${label} within ${ms} ms`))
      }, ms)
      const on = (e: Event) => {
        if (!pick(e)) return
        clearTimeout(timer)
        this.listeners.delete(on)
        resolve(e)
      }
      this.listeners.add(on)
    })
  }

  close(): void {
    this.socket.close()
  }
}

/** The host from source, in a data folder of its own; resolves with its port and token once it says it is ready */
function startHost(data: string, home: string, raw: string, token: string, started: (child: ChildProcess) => void): Promise<{ child: ChildProcess; port: number }> {
  // The token goes on stdin, not on the command line (every process of this user reads that); the host ends when the pipe does (`--watch-parent`)
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/agent-host/src/main.ts'), '--port', '0', '--db', join(data, 'store.db'), '--watch-parent'], {
    cwd: ROOT,
    // A home folder of its own too: Codex reads the person's skills from `~/.agents`, and a model that is offered them may open them
    env: { ...process.env, CC_DATA_DIR: data, CC_RECORD_FRAMES: raw, HOME: home, USERPROFILE: home, CC_HOST_TOKEN_ON_STDIN: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  started(child)
  child.stdin!.write(`${JSON.stringify({ token })}\n`)
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('the host was not ready within 60 s')), 60_000)
    child.once('exit', (code) => reject(new Error(`the host ended (${code}) before it was ready`)))
    child.stdout!.on('data', (d: Buffer) => {
      buffer += String(d)
      for (const line of buffer.split('\n')) {
        try {
          const ready = JSON.parse(line) as { ready?: boolean; port?: number }
          if (ready.ready && ready.port) {
            clearTimeout(timer)
            return resolve({ child, port: ready.port })
          }
        } catch {
          // Not the ready line
        }
      }
    })
  })
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const rawAt = args.indexOf('--raw')
  const keepRaw = rawAt >= 0 ? args.splice(rawAt, 2)[1] : undefined
  const toolName = args[0] === 'claude' || args[0] === 'codex' ? (args.shift() as 'claude' | 'codex') : 'codex'
  const tool = TOOLS[toolName]
  const chosen = tool.scenarios.filter((s) => args.length === 0 || args.includes(s.name))
  let failed = 0
  const data = mkdtempSync(join(tmpdir(), 'frames-data-'))
  let config: { finish(): void } = { finish() {} }
  let host: ChildProcess | null = null
  // What the run in progress has made, for an interrupted run to take away (the copy of the sign-in is in `data`)
  const open_: string[] = []
  const stop = () => {
    host?.kill('SIGKILL')
    config.finish()
    for (const dir of [...open_, data]) rmSync(dir, { recursive: true, force: true })
    process.exit(130)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    config = toolName === 'claude' ? temporaryClaudeConfig(data) : temporaryCodexHome(data)
    for (const scenario of chosen) {
      const folder = realpathSync(mkdtempSync(join(tmpdir(), `frames-record-${scenario.name}-`)))
      const raw = keepRaw ? join(keepRaw, scenario.name) : mkdtempSync(join(tmpdir(), 'frames-raw-'))
      mkdirSync(raw, { recursive: true })
      open_.push(folder, raw)
      const window = new Window()
      try {
        const token = randomBytes(24).toString('hex')
        const home = join(data, 'home')
        mkdirSync(home, { recursive: true })
        const started = await startHost(data, home, raw, token, (child) => (host = child))
        await window.open(started.port, token)
        const project = await window.rpc<{ id: string }>('projects.add', { path: folder })
        window.expected = scenario.cards ?? []
        if (scenario.trusted) await window.rpc('projects.setTrusted', { projectId: project.id, trusted: true })
        // A second project when the scenario reaches one: its folder's name is the project's
        let otherProject: { id: string } | null = null
        const other = scenario.otherProject ? realpathSync(mkdtempSync(join(tmpdir(), 'frames-record-other-'))) : null
        if (other) {
          open_.push(other)
          otherProject = await window.rpc<{ id: string }>('projects.add', { path: other })
        }
        const open = async (prompt: string, where?: { projectId: string; cwd: string }): Promise<string> => {
          const made = await window.rpc<{ id?: string; sessionId?: string }>('agents.createSession', { projectId: where?.projectId ?? project.id, cwd: where?.cwd ?? folder, tool: toolName, model: tool.model, ...(tool.effort ? { effort: tool.effort } : {}), permissionPreset: 'auto' })
          const id = made.id ?? made.sessionId!
          await turn(id, prompt)
          return id
        }
        const turn = async (id: string, text: string) => {
          const done = window.waitFor(`the end of the turn "${text.slice(0, 30)}"`, (e) => e.sessionId === id && (e.type === 'turn_complete' || e.type === 'error'))
          await window.rpc('agents.send', { sessionId: id, text })
          const e = await done
          if (e.type === 'error') throw new Error(`the turn "${text.slice(0, 30)}" failed: ${JSON.stringify(e.error)}`)
        }
        const said = (text: string) => (other ? text.replaceAll('{other}', basename(other)) : text)
        for (const helper of scenario.helpers) await open(helper)
        if (scenario.otherSession && other && otherProject) await open(scenario.otherSession, { projectId: otherProject.id, cwd: other })
        const main = await open(said(scenario.turns[0]!))
        for (const text of scenario.turns.slice(1)) await turn(main, said(text))
        // All armed together: the events come close behind each other (a compaction, then the end of its turn), and a wait only sees what comes after it starts
        await Promise.all((scenario.then ?? []).map((next) => window.waitFor(next.label, (e) => e.sessionId === main && e.type === next.type, 240_000)))
        if (scenario.after) await turn(main, scenario.after)
        // The recording of the session the scenario keeps: the one whose process made the tool calls
        if (window.unexpected.length) throw new Error(`the host raised cards the scenario does not expect (refused): ${window.unexpected.join(', ')}`)
        const files = readdirSync(raw).filter((n) => n.startsWith(`${main}.`)).sort((a, b) => Number(a.split('.').at(-2)) - Number(b.split('.').at(-2)))
        const frames = files.flatMap((f) => readFileSync(join(raw, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        const adapter = await import(`../packages/agent-host/src/adapters/${toolName}/index.js`).then((m) => (toolName === 'claude' ? new m.ClaudeAdapter() : new m.CodexAdapter()) as { installedVersion?(): Promise<string | undefined> })
        const version = (await adapter.installedVersion?.()) ?? 'unknown'
        const dir = join(ADAPTERS, toolName, 'recordings', `${tool.prefix}-${version.replace(/^codex-cli /, '').split(/[-\s]/)[0]}`)
        mkdirSync(dir, { recursive: true })
        const header = { header: { tool: toolName, version, scenario: scenario.name, preset: 'auto', protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10), host: true } }
        writeFileSync(join(dir, `${scenario.name}.jsonl`), [header, ...scrub(frames, folder, undefined, { cutText: scenario.cutText })].map((l) => JSON.stringify(l)).join('\n') + '\n')
        console.log(`[record] ${toolName} ${scenario.name} (through a host): ${frames.length} frames -> ${dir}`)
      } catch (e) {
        failed++
        console.error(`[record] ${toolName} ${scenario.name}: ${(e as Error).message}`)
      } finally {
        window.close()
        host?.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 1500))
        host?.kill('SIGKILL')
        await removeDir(folder)
        for (const dir of open_.splice(2)) await removeDir(dir)
        open_.length = 0
        if (!keepRaw) await removeDir(raw)
      }
    }
  } finally {
    config.finish()
    await removeDir(data)
  }
  return failed ? 1 : 0
}

process.exit(await main())
