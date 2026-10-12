/**
 * Probe: does the host name each prompt cache rebuild's cause right (docs/agent-host.md §6.1)?
 *
 * Live, on the person's own Claude login, on haiku (one sonnet turn for the model change). Two hosts on a temporary
 * data folder (`CC_DATA_DIR` and `--db` inside it, never `~/.centralu`), auto memory and claude.ai connectors off:
 *
 *   host A (the CLI's own cache lifetime):  first turn · ordinary turn · /compact then a turn · restart then a turn ·
 *                                            model change (sonnet) then a turn
 *   host B (FORCE_PROMPT_CACHING_5M=1):      first turn · ordinary turn · idle past five minutes · a turn
 *
 * After each step it prints every request the host counted (its input split and the lifetime the API reported) and
 * the rebuild causes `agents.usage` answers with, so each step's new rebuild can be read against what was done.
 *
 *   pnpm exec tsx packages/agent-host/scripts/probe-cache-causes.mts [--idle-min 6] [--skip-idle]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { MeasuredHost, type Json } from './measure-tools/host.mjs'

const { values: opt } = parseArgs({
  options: {
    'idle-min': { type: 'string', default: '6' },
    'skip-idle': { type: 'boolean', default: false },
    model: { type: 'string', default: 'haiku' },
    'change-model': { type: 'string', default: 'sonnet' },
  },
})

const root = mkdtempSync(join(tmpdir(), 'cc-probe-cache-causes-'))
const ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }

function project(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nA scratch project for the cache probe.\n`)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'add', '.'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

async function startHost(name: string, extra: Record<string, string>): Promise<{ host: MeasuredHost; sessionId: string }> {
  const data = join(root, `data-${name}`)
  mkdirSync(data)
  const host = new MeasuredHost(data, { ...ENV, ...extra })
  await host.start()
  const dir = project(`project-${name}`)
  const p = await host.rpc('projects.add', { path: dir })
  await host.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  const s = await host.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude', model: opt.model, permissionPreset: 'normal' })
  if (s.model !== opt.model) await host.rpc('agents.updateSettings', { sessionId: s.id, model: opt.model })
  return { host, sessionId: s.id }
}

let seen = 0
async function step(host: MeasuredHost, label: string, sessionId: string, act: () => Promise<unknown>): Promise<void> {
  const from = host.events.length
  await act()
  const requests = host.events
    .slice(from)
    .filter((e: Json) => e.type === 'usage_update' && e.request && e.sessionId === sessionId)
    .map((e: Json) => e.request)
  const usage = await host.rpc('agents.usage', { tool: 'claude' })
  const w = usage.cache?.windows?.[0] ?? {}
  console.log(`\n## ${label}`)
  for (const r of requests) {
    const total = r.inputTokens + r.cacheReadTokens + (r.cacheCreationTokens ?? 0)
    console.log(
      `  request${r.agent ? ` (subagent ${String(r.agent).slice(0, 8)})` : ''}: input ${r.inputTokens}, read ${r.cacheReadTokens}, wrote ${r.cacheCreationTokens} of ${total}, ttl ${r.cacheTtl ?? '-'}`,
    )
  }
  const n = Number(w.rebuilds ?? 0)
  console.log(`  rebuilds so far ${n} (${n - seen} new): ${JSON.stringify(w.rebuildCauses ?? {})}${w.expiredIdleMs ? ` idle ${JSON.stringify(w.expiredIdleMs)}` : ''}`)
  seen = n
}

const say = 'Reply with the single word: ok'
try {
  {
    seen = 0
    const { host, sessionId: id } = await startHost('a', {})
    console.log('# host A: the CLI chooses the cache lifetime')
    await step(host, 'first turn (expect cold start, or a read of a prefix cached by another run)', id, () => host.turn(id, say))
    await step(host, 'ordinary turn (expect no rebuild)', id, () => host.turn(id, say))
    await step(host, '/compact (the compaction call itself)', id, () => host.turn(id, '/compact'))
    await step(host, 'turn after compaction (expect compaction)', id, () => host.turn(id, say))
    await step(host, 'restart, then a turn (expect new process, if it rebuilds)', id, async () => {
      await host.rpc('agents.restartSession', { sessionId: id })
      await host.turn(id, say)
    })
    await step(host, `model change to ${opt['change-model']}, then a turn (expect model change)`, id, async () => {
      await host.rpc('agents.updateSettings', { sessionId: id, model: opt['change-model'] })
      await host.turn(id, say)
    })
    await host.stop()
  }
  if (!opt['skip-idle']) {
    seen = 0
    const { host, sessionId: id } = await startHost('b', { FORCE_PROMPT_CACHING_5M: '1' })
    console.log('\n# host B: FORCE_PROMPT_CACHING_5M=1')
    await step(host, 'first turn', id, () => host.turn(id, say))
    await step(host, 'ordinary turn (expect no rebuild, ttl 5m)', id, () => host.turn(id, say))
    const idleMin = Number(opt['idle-min'])
    console.log(`\n  idle ${idleMin} min…`)
    await new Promise((r) => setTimeout(r, idleMin * 60_000))
    await step(host, `turn after ${idleMin} min idle (expect cache expired)`, id, () => host.turn(id, say))
    await host.stop()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
