#!/usr/bin/env -S npx tsx
/**
 * Records the scenarios against an installed CLI (docs/plans/acp-adapter.md §10.5, #1498):
 *
 *   pnpm exec tsx scripts/frames-record.mts <cursor-agent | opencode | claude> [scenario ...] [--raw <folder>]
 *
 * Each scenario (`adapters/frames/scenarios.test-helpers.ts`) drives the real adapter, as the host would, in a new
 * temporary folder; the adapter's own recorder writes the frames, and they are scrubbed into
 * `adapters/<acp | claude>/recordings/<tool>-<version>/<scenario>.jsonl`, which the tool's replay test plays back. A tool
 * update shows as a diff in those files. It spends model calls: OpenCode's run is free (its free models, no login);
 * Cursor's and Claude's spend the person's plan (Claude on its smallest model, with no settings file read), so run
 * them by hand. It never starts a host, and its data folder (`CC_DATA_DIR`, where Windows keeps the Claude program's
 * link) is a temporary one. `--raw`: keep the unscrubbed frames in that folder (they hold paths and ids: not to commit).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpAdapter } from '../packages/agent-host/src/adapters/acp/adapter.js'
import { ClaudeAdapter } from '../packages/agent-host/src/adapters/claude/index.js'
import { drive, scenariosFor, type Scenario } from '../packages/agent-host/src/adapters/frames/scenarios.test-helpers.js'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec } from '../packages/agent-host/src/adapters/contract.js'
import { cursorProfile } from '../packages/agent-host/src/adapters/cursor-agent/index.js'
import { spawnLocalAgent } from '../packages/agent-host/src/adapters/local-process.js'
import { openCodeProfile } from '../packages/agent-host/src/adapters/opencode/index.js'
import { scrub } from './frames-scrub.mts'

const ADAPTERS = fileURLToPath(new URL('../packages/agent-host/src/adapters/', import.meta.url))
const TOOLS = ['cursor-agent', 'opencode', 'claude']

class RecordingAdapter extends AcpAdapter {
  readonly tool = 'recording'
}

/** The cheapest model Claude Code offers: a recording only needs the frames, not an answer worth reading */
const CLAUDE_MODEL = 'haiku'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const rawAt = args.indexOf('--raw')
  const keepRaw = rawAt >= 0 ? args.splice(rawAt, 2)[1] : undefined
  const [tool, ...names] = args
  if (!tool || !TOOLS.includes(tool)) {
    console.error('usage: frames-record.mts <cursor-agent | opencode | claude> [scenario ...] [--raw <folder>]')
    return 2
  }
  const chosen = scenariosFor(tool).filter((s) => names.length === 0 || names.includes(s.name))
  const data = mkdtempSync(join(tmpdir(), 'frames-data-'))
  process.env.CC_DATA_DIR = data
  let failed = 0
  try {
    for (const scenario of chosen) {
      const cwd = mkdtempSync(join(tmpdir(), `frames-record-${scenario.name}-`))
      const raw = keepRaw ? join(keepRaw, scenario.name) : mkdtempSync(join(tmpdir(), 'frames-raw-'))
      process.env.CC_RECORD_FRAMES = raw
      let last: AgentProcess | null = null
      const spawn = (spec: AgentSpawnSpec) => (last = spawnLocalAgent(spec))
      const adapter = adapterFor(tool, spawn)
      const version = (await adapter.installedVersion?.()) ?? 'unknown'
      const sessionId = `record-${scenario.name}`
      try {
        const run = runAs(tool, scenario)
        const events = await drive(adapter, run, cwd, sessionId, 300_000, () => last?.kill('SIGKILL'), { seed: (files: Record<string, string | Buffer>) => seedFiles(cwd, files), tool, ...(tool === 'claude' ? { session: { model: CLAUDE_MODEL, noSettingFiles: true } } : {}) })
        // One file per process, in the order they started (`recorder.ts`)
        const files = readdirSync(raw)
          .filter((n) => n.startsWith(`${sessionId}.`))
          .sort((a, b) => Number(a.split('.').at(-2)) - Number(b.split('.').at(-2)))
        const frames = files.flatMap((file) => readFileSync(join(raw, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        const dir = join(ADAPTERS, tool === 'claude' ? 'claude' : 'acp', 'recordings', `${tool === 'claude' ? 'claude-code' : tool}-${version.replace(/^agent /, '').split(/[-\s]/)[0]}`)
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
    await removeDir(data)
  }
  return failed ? 1 : 0
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
  return new RecordingAdapter(tool === 'cursor-agent' ? cursorProfile() : openCodeProfile(), spawn)
}

/** OpenCode and Claude ask for every command under Safe only (their preset config); Cursor asks under Normal */
function runAs(tool: string, scenario: Scenario): Scenario {
  const preset = scenario.presetFor?.[tool] ?? (tool !== 'cursor-agent' && scenario.asksForCommands ? 'safe' : undefined)
  return preset ? { ...scenario, preset } : scenario
}

process.exit(await main())
