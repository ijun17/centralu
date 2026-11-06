#!/usr/bin/env -S npx tsx
/**
 * Records the scenarios against an installed CLI (docs/plans/acp-adapter.md §10.5, #1498):
 *
 *   pnpm exec tsx scripts/frames-record.mts <cursor-agent | opencode | claude | codex> [scenario ...] [--raw <folder>]
 *
 * Each scenario (`adapters/frames/scenarios.test-helpers.ts`) drives the real adapter, as the host would, in a new
 * temporary folder; the adapter's own recorder writes the frames, and they are scrubbed into
 * `adapters/<acp | claude>/recordings/<tool>-<version>/<scenario>.jsonl`, which the tool's replay test plays back. A tool
 * update shows as a diff in those files. It spends model calls: OpenCode's run is free (its free models, no login);
 * Cursor's and Claude's spend the person's plan (Claude on its smallest model, with no settings file read), so run
 * them by hand. It never starts a host, and its data folder (`CC_DATA_DIR`, where Windows keeps the Claude program's
 * link) is a temporary one. `--raw`: keep the unscrubbed frames in that folder (they hold paths and ids: not to commit).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { scrub } from './frames-scrub.mts'

const ADAPTERS = fileURLToPath(new URL('../packages/agent-host/src/adapters/', import.meta.url))
const TOOLS = ['cursor-agent', 'opencode', 'claude', 'codex']

class RecordingAdapter extends AcpAdapter {
  readonly tool = 'recording'
}

/** The cheapest model Claude Code offers: a recording only needs the frames, not an answer worth reading */
const CLAUDE_MODEL = 'haiku'
/** Codex's smallest model, with the least reasoning */
const CODEX_MODEL = 'gpt-5.6-luna'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const rawAt = args.indexOf('--raw')
  const keepRaw = rawAt >= 0 ? args.splice(rawAt, 2)[1] : undefined
  const [tool, ...names] = args
  if (!tool || !TOOLS.includes(tool)) {
    console.error('usage: frames-record.mts <cursor-agent | opencode | claude | codex> [scenario ...] [--raw <folder>]')
    return 2
  }
  const chosen = scenariosFor(tool).filter((s) => names.length === 0 || names.includes(s.name))
  const data = mkdtempSync(join(tmpdir(), 'frames-data-'))
  process.env.CC_DATA_DIR = data
  let codexHome: { finish(): void } | null = null
  let failed = 0
  // An interrupted run still puts a refreshed sign-in back and takes its temporary folder away
  const stop = () => {
    codexHome?.finish()
    rmSync(data, { recursive: true, force: true })
    process.exit(130)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    codexHome = tool === 'codex' ? temporaryCodexHome(data) : null
    for (const scenario of chosen) {
      // Resolved, so the folder reads the same wherever a tool prints it (macOS: `/var` is `/private/var`)
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), `frames-record-${scenario.name}-`)))
      const raw = keepRaw ? join(keepRaw, scenario.name) : mkdtempSync(join(tmpdir(), 'frames-raw-'))
      process.env.CC_RECORD_FRAMES = raw
      let last: AgentProcess | null = null
      const spawn = (spec: AgentSpawnSpec) => (last = spawnLocalAgent(spec))
      const adapter = adapterFor(tool, spawn)
      const version = (await adapter.installedVersion?.()) ?? 'unknown'
      const sessionId = `record-${scenario.name}`
      try {
        const run = runAs(tool, scenario)
        const events = await drive(adapter, run, cwd, sessionId, 300_000, () => last?.kill('SIGKILL'), { seed: (files: Record<string, string | Buffer>) => seedFiles(cwd, files), tool, ...sessionFor(tool, spawn) })
        // One file per process, in the order they started (`recorder.ts`)
        const files = readdirSync(raw)
          .filter((n) => n.startsWith(`${sessionId}.`))
          .sort((a, b) => Number(a.split('.').at(-2)) - Number(b.split('.').at(-2)))
        const frames = files.flatMap((file) => readFileSync(join(raw, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        const dir = join(ADAPTERS, ADAPTER_FOLDER[tool] ?? 'acp', 'recordings', `${tool === 'claude' ? 'claude-code' : tool}-${version.replace(/^(agent|codex-cli) /, '').split(/[-\s]/)[0]}`)
        mkdirSync(dir, { recursive: true })
        const header = { header: { tool, version, scenario: scenario.name, preset: run.preset ?? 'normal', protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
        writeFileSync(join(dir, `${scenario.name}.jsonl`), [header, ...scrub(frames, cwd)].map((l) => JSON.stringify(l)).join('\n') + '\n')
        console.log(`[record] ${tool} ${scenario.name}: ${frames.length} frames, ${events.length} events -> ${dir}`)
      } catch (e) {
        failed++
        console.error(`[record] ${tool} ${scenario.name}: ${(e as Error).message}`)
      } finally {
        await removeDir(cwd)
        if (!keepRaw) rmSync(raw, { recursive: true, force: true })
      }
    }
  } finally {
    codexHome?.finish()
    await removeDir(data)
  }
  return failed ? 1 : 0
}

/** The folder each non-ACP tool's adapter, and so its recordings, live in */
const ADAPTER_FOLDER: Record<string, string> = { claude: 'claude', codex: 'codex' }

/** What a session of `tool` is opened with in a recording run: the cheapest model, and the process the run can kill (`die`) */
function sessionFor(tool: string, spawn: (spec: AgentSpawnSpec) => AgentProcess): { session?: Partial<CreateSessionOpts> } {
  if (tool === 'claude') return { session: { model: CLAUDE_MODEL, noSettingFiles: true, processSource: { spawn } } }
  if (tool === 'codex') return { session: { model: CODEX_MODEL, effort: 'low', processSource: { spawn } } }
  return {}
}

/**
 * A Codex settings folder of its own for the run (`CODEX_HOME`), so no setting, skill, hook or thread of the person's is read or
 * written. It holds a copy of the sign-in alone. Codex rotates the refresh token when it refreshes one, which would leave the
 * person's own file with a token it no longer accepts: if the copy changed, `finish` puts it back into the person's file, unless
 * that file changed meanwhile (another Codex refreshed it: its token is the newer one and stays). The put-back is a rename, so
 * the file is never half written.
 */
function temporaryCodexHome(parent: string): { finish(): void } {
  const real = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'auth.json')
  const home = join(parent, 'codex-home')
  mkdirSync(home, { recursive: true })
  const copy = join(home, 'auth.json')
  if (!existsSync(real)) throw new Error('codex is not signed in: run `codex login` first')
  copyFileSync(real, copy)
  const before = readFileSync(copy, 'utf8')
  process.env.CODEX_HOME = home
  let done = false
  return {
    finish() {
      if (done) return
      done = true
      const now = readFileSync(copy, 'utf8')
      if (now === before) return
      if (readFileSync(real, 'utf8') !== before) return console.error('[record] the sign-in was refreshed during the run, and the person\'s own file was too: left as it is')
      const next = `${real}.${process.pid}.tmp`
      writeFileSync(next, now, { mode: 0o600 })
      renameSync(next, real)
      console.log('[record] the sign-in was refreshed during the run: kept in the person\'s auth file')
    },
  }
}

/** The files a scenario asks the tool to find in its working folder */
function seedFiles(cwd: string, files: Record<string, string | Buffer>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), text)
  }
}

/** Removes a folder a tool's process may still hold for a moment after the session closed (Windows will not remove a folder that is some process's working folder) */
async function removeDir(dir: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (tries >= 60) return console.error(`[record] could not remove ${dir}: ${(e as Error).message}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
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
