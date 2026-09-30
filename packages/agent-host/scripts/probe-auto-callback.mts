/**
 * If a `canUseTool` callback is passed with auto (`bypassPermissions`), what reaches the callback?
 * (#171, an auto-mode line added to #92's probe-project-trust).
 *
 * Auto mode does not pass a callback, so AskUserQuestion never reached the person. Measure before
 * passing one:
 *   1. Does AskUserQuestion reach the callback? (read from the CLI bundle: a requiresUserInteraction
 *      tool asks before bypass takes effect)
 *   2. Does an ordinary tool (Bash) still skip the callback? (probe-perm2's "not called under bypass")
 *   3. What happens to a request that matches an `ask` rule in the settings file — with and without
 *      a callback
 *
 * Runs briefly against haiku in a temp folder (one model call per line). Does not touch the
 * person's real ~/.claude.
 * Run with: node --import tsx packages/agent-host/scripts/probe-auto-callback.mts
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const claude = execFileSync('which', ['claude']).toString().trim()

async function run(label: string, prompt: string, opts: { callback: boolean; plantAsk: boolean; sources?: string[] }) {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-auto-'))
  if (opts.plantAsk) {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(touch cc-auto-probe.txt)'] } }))
  }
  const seen: string[] = []
  const results: string[] = []
  const q = query({
    prompt,
    options: {
      cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: claude,
      permissionMode: 'bypassPermissions',
      ...(opts.sources ? { settingSources: opts.sources } : {}),
      ...(opts.callback
        ? {
            canUseTool: async (n: string, i: Record<string, unknown>) => {
              seen.push(n)
              // Same as what the adapter does — the answer to the choice travels in deny's message
              if (n === 'AskUserQuestion') return { behavior: 'deny' as const, message: '{"answers":[{"answer":"A"}]}' }
              return { behavior: 'allow' as const, updatedInput: i }
            },
          }
        : {}),
    } as never,
  })
  for await (const msg of q) {
    const m = msg as Record<string, unknown>
    const content = ((m.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[]
    if (m.type === 'user') for (const b of content) if (b.type === 'tool_result') results.push(JSON.stringify(b.content).slice(0, 120))
    if (m.type === 'result') break
  }
  console.log(`\n${label}`)
  console.log(`  callback saw: ${seen.join(', ') || '(nothing)'}`)
  console.log(`  touch ran: ${existsSync(join(cwd, 'cc-auto-probe.txt')) ? 'yes' : 'no'}`)
  for (const r of results) console.log(`  tool_result: ${r}`)
}

const ASK_THEN_TOUCH =
  'First call the AskUserQuestion tool once to ask me "Pick one" with the options "A" and "B". ' +
  'Then use the Bash tool to run exactly: touch cc-auto-probe.txt\nThen reply with one short sentence.'
const TOUCH = 'Use the Bash tool to run exactly: touch cc-auto-probe.txt\nThen reply with one short sentence.'

await run("1. auto + callback, untrusted (['user'])", ASK_THEN_TOUCH, { callback: true, plantAsk: false, sources: ['user'] })
await run('2. auto + callback, trusted, planted ask rule', TOUCH, { callback: true, plantAsk: true })
await run('3. auto, no callback, trusted, planted ask rule (today)', TOUCH, { callback: false, plantAsk: true })
process.exit(0)
