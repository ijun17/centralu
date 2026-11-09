#!/usr/bin/env -S npx tsx
/**
 * Records the scenarios against an installed CLI (docs/plans/acp-adapter.md §10.5, #1498):
 *
 *   pnpm exec tsx scripts/frames-record.mts <cursor-agent | opencode | claude | codex | antigravity> [scenario ...] [--raw <folder>]
 *
 * Each scenario (`adapters/frames/scenarios.test-helpers.ts`) drives the real adapter, as the host would, in a new
 * temporary folder; the adapter's own recorder writes the frames, and they are scrubbed into
 * `adapters/<acp | claude>/recordings/<tool>-<version>/<scenario>.jsonl`, which the tool's replay test plays back. A tool
 * update shows as a diff in those files. It spends model calls: OpenCode's run is free (its free models, no login);
 * Cursor's and Claude's spend the person's plan (Claude on its smallest model, with no settings file read), so run
 * them by hand. It never starts a host, and its data folder (`CC_DATA_DIR`, where Windows keeps the Claude program's
 * link) is a temporary one; so are OpenCode's XDG folders. A scenario that gives an ACP agent Centralu's tools (`centralu-*`) runs
 * the real stdio bridge against a host of fixed answers (`scripts/frames-bridge-host.mts`). Antigravity runs the installed `agy acp`
 * (`frames-record-agy.mts`). `--raw`: keep the unscrubbed frames in that folder (they hold paths and ids: not to commit).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpAdapter } from '../packages/agent-host/src/adapters/acp/adapter.js'
import { ClaudeAdapter } from '../packages/agent-host/src/adapters/claude/index.js'
import { CodexAdapter } from '../packages/agent-host/src/adapters/codex/index.js'
import { drive, scenariosFor, type Scenario } from '../packages/agent-host/src/adapters/frames/scenarios.test-helpers.js'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts } from '../packages/agent-host/src/adapters/contract.js'
import { cursorProfile } from '../packages/agent-host/src/adapters/cursor-agent/index.js'
import { spawnLocalAgent } from '../packages/agent-host/src/adapters/local-process.js'
import { openCodeProfile } from '../packages/agent-host/src/adapters/opencode/index.js'
import { startBridgeHost, type BridgeHost } from './frames-bridge-host.mts'
import { AGY_MODEL, temporaryAgy } from './frames-record-agy.mts'
import { removeDir, temporaryClaudeConfig, temporaryCodexHome } from './frames-record-kit.mts'
import { scrub } from './frames-scrub.mts'

const ADAPTERS = fileURLToPath(new URL('../packages/agent-host/src/adapters/', import.meta.url))
const TOOLS = ['cursor-agent', 'opencode', 'claude', 'codex', 'antigravity']
const ACP_TOOLS = ['cursor-agent', 'opencode', 'antigravity']

class RecordingAdapter extends AcpAdapter {
  readonly tool = 'recording'
}

/** The cheapest model Claude Code offers: a recording only needs the frames, not an answer worth reading */
const CLAUDE_MODEL = 'haiku'
/** Codex's smallest model, with the least reasoning */
const CODEX_MODEL = 'gpt-5.6-luna'
/**
 * Cursor runs on Auto: the ACP adapter sets no model, and Auto is the one the Free plan includes (`Model unavailable on Free: Free
 * includes Grok 4.7, Grok 4.6, and Auto`), so no explicit one is cheaper on this account. Another plan's model is named here when the
 * adapter can set one.
 */
const CURSOR_MODEL = 'auto'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const rawAt = args.indexOf('--raw')
  const keepRaw = rawAt >= 0 ? args.splice(rawAt, 2)[1] : undefined
  const [tool, ...names] = args
  if (!tool || !TOOLS.includes(tool)) {
    console.error('usage: frames-record.mts <cursor-agent | opencode | claude | codex | antigravity> [scenario ...] [--raw <folder>]')
    return 2
  }
  const wanted = (s: { name: string }) => names.length === 0 || names.includes(s.name)
  const chosen: { name: string; drive: Scenario }[] = scenariosFor(tool).filter(wanted).map((drive) => ({ name: drive.name, drive }))
  const data = mkdtempSync(join(tmpdir(), 'frames-data-'))
  process.env.CC_DATA_DIR = data
  let codexHome: { finish(): void } | null = null
  let agy: ReturnType<typeof temporaryAgy> | null = null
  // OpenCode keeps its settings, sessions and cache by the XDG folders: a run gets folders of its own (a config OpenCode also reads from the home folder, `~/.opencode`, is not moved)
  if (tool === 'opencode') for (const [name, folder] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state'], ['XDG_CACHE_HOME', 'cache']] as const) process.env[name] = join(data, 'opencode', folder)
  let claudeConfig: { finish(): void; mcpConfig(): string } | null = null
  let failed = 0
  // An interrupted run still puts a refreshed sign-in back and takes its temporary folder away
  const stop = () => {
    codexHome?.finish()
    claudeConfig?.finish()
    agy?.finish()
    rmSync(data, { recursive: true, force: true })
    process.exit(130)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    codexHome = tool === 'codex' ? temporaryCodexHome(data) : null
    claudeConfig = tool === 'claude' ? temporaryClaudeConfig(data) : null
    for (const scenario of chosen) {
      codexHome?.settings(scenario.drive.settings === 'mcp' ? 'mcp' : undefined)
      // Resolved, so the folder reads the same wherever a tool prints it (macOS: `/var` is `/private/var`)
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `frames-record-${scenario.name}-`)))
      const raw = keepRaw ? join(keepRaw, scenario.name) : mkdtempSync(join(tmpdir(), 'frames-raw-'))
      process.env.CC_RECORD_FRAMES = raw
      let last: AgentProcess | null = null
      const spawn = (spec: AgentSpawnSpec) => (last = spawnLocalAgent(tool === 'claude' ? claudeFlags(spec, scenario.drive.settings, claudeConfig) : spec))
      agy = tool === 'antigravity' ? temporaryAgy(data, scenario.name, scenario.drive.signedOut === true) : null
      const adapter = agy ? agy.adapter(spawn) : adapterFor(tool, spawn)
      const version = (await adapter.installedVersion?.()) ?? 'unknown'
      const sessionId = `record-${scenario.name}`
      let bridge: BridgeHost | null = null
      const outside: string[] = []
      try {
        const run: { preset?: string } = runAs(tool, scenario.drive)
        // An ACP agent reaches Centralu's tools through the stdio bridge, which asks a host: this run's is a fixed-answer one
        const given = ACP_TOOLS.includes(tool) ? scenario.drive.session?.() : undefined
        if (given?.centraluTools) bridge = await startBridgeHost(given.centraluTools, given.toolProfile ?? 'reader')
        const session = { ...sessionFor(tool, spawn).session, ...(bridge ? { centraluBridge: { url: bridge.url, token: bridge.token } } : {}) }
        const events = await drive(adapter, run as Scenario, cwd, sessionId, 300_000, () => last?.kill('SIGKILL'), { seed: (files: Record<string, string | Buffer>) => outside.push(...seedFiles(cwd, files)), tool, session })
        // One file per process, in the order they started (`recorder.ts`)
        const files = readdirSync(raw)
          .filter((n) => n.startsWith(`${sessionId}.`))
          .sort((a, b) => Number(a.split('.').at(-2)) - Number(b.split('.').at(-2)))
        const frames = files.flatMap((file) => readFileSync(join(raw, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        const dir = join(ADAPTERS, ADAPTER_FOLDER[tool] ?? 'acp', 'recordings', `${tool === 'claude' ? 'claude-code' : tool}-${version.replace(/^(agent|codex-cli) /, '').split(/[-\s]/)[0]}`)
        mkdirSync(dir, { recursive: true })
        const header = { header: { tool, version, model: modelOf(tool), scenario: scenario.name, preset: run.preset ?? 'normal', protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
        writeFileSync(join(dir, `${scenario.name}.jsonl`), [header, ...bridgeAsPlaceholders(scrub(frames, cwd))].map((l) => JSON.stringify(l)).join('\n') + '\n')
        console.log(`[record] ${tool} ${scenario.name}: ${frames.length} frames, ${events.length} events -> ${dir}`)
      } catch (e) {
        failed++
        console.error(`[record] ${tool} ${scenario.name}: ${(e as Error).message}`)
      } finally {
        for (const path of outside) rmSync(path, { recursive: true, force: true })
        await bridge?.close()
        await removeDir(cwd)
        if (!keepRaw) rmSync(raw, { recursive: true, force: true })
        // Last: a token file that is gone or changed must not stop the rest of the cleanup
        try {
          agy?.finish()
        } catch (e) {
          console.error(`[record] could not put the sign-in back: ${(e as Error).message}`)
        }
      }
    }
  } finally {
    codexHome?.finish()
    claudeConfig?.finish()
    await removeDir(data)
  }
  return failed ? 1 : 0
}

/** The model a recording of `tool` runs on, for its header (OpenCode: its free models, no choice made) */
function modelOf(tool: string): string {
  return { claude: CLAUDE_MODEL, codex: CODEX_MODEL, antigravity: AGY_MODEL, 'cursor-agent': CURSOR_MODEL }[tool] ?? 'default'
}

/**
 * Claude Code's own settings for a scenario, as flags of its process (the run reads no settings file): an MCP server to connect, or
 * the task-list tools. They are appended after the flags the SDK passes. Thinking takes none: a recording runs as a session does,
 * whose thinking the model decides and whose text the adapter asks for (#2062)
 */
function claudeFlags(spec: AgentSpawnSpec, settings: Scenario['settings'], config: { mcpConfig(): string } | null): AgentSpawnSpec {
  if (settings === 'mcp' && config) return { ...spec, args: [...spec.args, '--mcp-config', config.mcpConfig()] }
  if (settings === 'tasks') return { ...spec, args: [...spec.args, '--tools', 'TaskCreate,TaskUpdate,TaskList'] }
  return spec
}

/** The folder each non-ACP tool's adapter, and so its recordings, live in */
const ADAPTER_FOLDER: Record<string, string> = { claude: 'claude', codex: 'codex', antigravity: 'antigravity' }

/** What a session of `tool` is opened with in a recording run: the cheapest model, and the process the run can kill (`die`) */
function sessionFor(tool: string, spawn: (spec: AgentSpawnSpec) => AgentProcess): { session?: Partial<CreateSessionOpts> } {
  if (tool === 'claude') return { session: { model: CLAUDE_MODEL, noSettingFiles: true, processSource: { spawn } } }
  if (tool === 'codex') return { session: { model: CODEX_MODEL, effort: 'low', processSource: { spawn } } }
  return {}
}

/**
 * The bridge a session is opened with names this machine's node, the bridge script's place in the checkout and this run's host port:
 * a recording keeps what the agent was told to start, in words that read the same wherever it is replayed
 */
function bridgeAsPlaceholders(frames: unknown[]): unknown[] {
  const places: Record<string, string> = { CC_HOST_URL: 'ws://127.0.0.1:<port>', CC_SESSION_ID: 'session-1' }
  for (const f of frames) {
    const msg = ((f as { msg?: { method?: string; params?: { mcpServers?: unknown } } }).msg ?? {}) as { method?: string; params?: { mcpServers?: unknown } }
    if (msg.method !== 'session/new' && msg.method !== 'session/load') continue
    for (const server of (Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : []) as { command?: string; args?: string[]; env?: { name: string; value: string }[] }[]) {
      server.command = 'node'
      server.args = ['<bridge>']
      for (const entry of server.env ?? []) if (places[entry.name]) entry.value = places[entry.name]!
    }
  }
  return frames
}

/** The files a scenario asks the tool to find in its working folder, and the folders it made outside it */
function seedFiles(cwd: string, files: Record<string, string | Buffer>): string[] {
  const outside: string[] = []
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), text)
    // A file the scenario puts beside the working folder (a read outside it) is taken away with the run
    if (name.startsWith('..')) outside.push(dirname(join(cwd, name)))
  }
  return outside
}

function adapterFor(tool: string, spawn: (spec: AgentSpawnSpec) => AgentProcess): AgentAdapter {
  if (tool === 'claude') return new ClaudeAdapter()
  if (tool === 'codex') return new CodexAdapter()
  return new RecordingAdapter(tool === 'cursor-agent' ? cursorProfile() : openCodeProfile(), spawn)
}

/** OpenCode, Claude and Codex ask for every command under Safe only (their preset config); Cursor asks under Normal */
function runAs(tool: string, scenario: Scenario): Scenario {
  const preset = scenario.presetFor?.[tool] ?? (tool !== 'cursor-agent' && scenario.asksForCommands ? 'safe' : undefined)
  return preset ? { ...scenario, preset } : scenario
}

process.exit(await main())
