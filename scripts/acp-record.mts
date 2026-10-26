#!/usr/bin/env -S npx tsx
/**
 * Records the ACP scenarios against an installed CLI (docs/plans/acp-adapter.md §10.5, #1498):
 *
 *   pnpm exec tsx scripts/acp-record.mts <cursor-agent | opencode> [scenario ...]
 *
 * Each scenario (`adapters/frames/scenarios.test-helpers.ts`) drives the real adapter, as the host would, in a new
 * temporary folder; the adapter's own recorder writes the frames, and they are scrubbed into
 * `adapters/acp/recordings/<tool>-<version>/<scenario>.jsonl`, which `replay.test.ts` plays back. A tool update shows as
 * a diff in those files. It spends model calls: OpenCode's run is free (its free models, no login); Cursor's spends the
 * person's plan, so run it by hand. It never starts a host and never touches the data folder.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdapterCapabilities } from '@cc/protocol'
import { AcpAdapter } from '../packages/agent-host/src/adapters/acp/adapter.js'
import type { AcpProfile } from '../packages/agent-host/src/adapters/acp/profile.js'
import { drive, SCENARIOS, type Scenario } from '../packages/agent-host/src/adapters/frames/scenarios.test-helpers.js'
import type { AgentProcess, AgentSpawnSpec } from '../packages/agent-host/src/adapters/contract.js'
import { cursorProfile } from '../packages/agent-host/src/adapters/cursor-agent/index.js'
import { spawnLocalAgent } from '../packages/agent-host/src/adapters/local-process.js'
import { whichTool } from '../packages/agent-host/src/env-path.js'
import { launchFor } from '../packages/agent-host/src/tool-launch.js'
import { scrub } from './frames-scrub.mts'

const OUT = fileURLToPath(new URL('../packages/agent-host/src/adapters/acp/recordings/', import.meta.url))

/** OpenCode is not registered yet (PR 3); its launch is all a recording needs */
function opencodeProfile(asks: boolean): AcpProfile {
  const path = whichTool('opencode')
  return {
    descriptor: { name: 'opencode', label: 'OpenCode', mark: 'O', install: 'npm i -g opencode-ai', login: 'opencode auth login' },
    capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true } as AdapterCapabilities,
    surface: undefined as never,
    async launch() {
      if (!path) return null
      const l = launchFor(path)
      // Measured: OpenCode asks for edits and commands when its config says `ask`
      return { command: l.command, args: [...l.args, 'acp'], env: asks ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', bash: 'ask' } }) } : {} }
    },
    async detect() {
      return { tool: 'opencode', installed: !!path, loggedIn: true, detail: '' }
    },
    async installedVersion() {
      return path ? execFileSync(launchFor(path).command, [...launchFor(path).args, '--version'], { encoding: 'utf8' }).trim() : null
    },
  }
}

class RecordingAdapter extends AcpAdapter {
  readonly tool = 'recording'
}

async function main(): Promise<number> {
  const [tool, ...names] = process.argv.slice(2)
  if (tool !== 'cursor-agent' && tool !== 'opencode') {
    console.error('usage: acp-record.mts <cursor-agent | opencode> [scenario ...]')
    return 2
  }
  const chosen = SCENARIOS.filter((s) => names.length === 0 || names.includes(s.name))
  let failed = 0
  for (const scenario of chosen) {
    const cwd = mkdtempSync(join(tmpdir(), `acp-record-${scenario.name}-`))
    const raw = mkdtempSync(join(tmpdir(), 'acp-raw-'))
    process.env.CC_RECORD_FRAMES = raw
    let last: AgentProcess | null = null
    const spawn = (spec: AgentSpawnSpec) => (last = spawnLocalAgent(spec))
    const adapter = adapterFor(tool, scenario, spawn)
    const version = (await adapter.installedVersion()) ?? 'unknown'
    const sessionId = `record-${scenario.name}`
    try {
      const events = await drive(adapter, scenario, cwd, sessionId, 300_000, () => last?.kill('SIGKILL'))
      // One file per process, in the order they started (`recorder.ts`)
      const files = readdirSync(raw)
        .filter((n) => n.startsWith(`${sessionId}.`))
        .sort((a, b) => Number(a.split('.').at(-2)) - Number(b.split('.').at(-2)))
      const frames = files.flatMap((file) => readFileSync(join(raw, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
      const dir = join(OUT, `${tool}-${version.replace(/^agent /, '').split('-')[0]}`)
      mkdirSync(dir, { recursive: true })
      const header = { header: { tool, version, scenario: scenario.name, protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
      writeFileSync(join(dir, `${scenario.name}.jsonl`), [header, ...scrub(frames, cwd)].map((l) => JSON.stringify(l)).join('\n') + '\n')
      console.log(`[record] ${tool} ${scenario.name}: ${frames.length} frames, ${events.length} events -> ${dir}`)
    } catch (e) {
      failed++
      console.error(`[record] ${tool} ${scenario.name}: ${(e as Error).message}`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(raw, { recursive: true, force: true })
    }
  }
  return failed ? 1 : 0
}

function adapterFor(tool: string, scenario: Scenario, spawn: (spec: AgentSpawnSpec) => AgentProcess): AcpAdapter {
  if (tool === 'cursor-agent') {
    return new RecordingAdapter(cursorProfile(), spawn)
  }
  return new RecordingAdapter(opencodeProfile(!!scenario.asksForCommands), spawn)
}

process.exit(await main())
