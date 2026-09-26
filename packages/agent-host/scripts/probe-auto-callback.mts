/**
 * auto(`bypassPermissions`)에 canUseTool을 넘기면 무엇이 콜백에 닿는가 (#171, #92의 probe-project-trust에 더하는 auto 줄).
 *
 * auto는 콜백을 넘기지 않아서 AskUserQuestion이 사람에게 닿지 않았다. 넘기기 전에 잰다:
 *   1. AskUserQuestion이 콜백으로 오는가 (CLI 번들 판독: requiresUserInteraction 도구는 bypass보다 먼저 ask)
 *   2. 보통 도구(Bash)는 여전히 콜백을 지나지 않는가 (probe-perm2의 "bypass에서는 안 불림")
 *   3. 설정 파일의 `ask` 규칙에 걸린 요청은 어떻게 되는가 — 콜백이 있을 때와 없을 때
 *
 * 임시 폴더에서 haiku로 짧게 돈다(줄마다 모델 호출 한 번). 사용자 ~/.claude는 건드리지 않는다.
 * 실행: node --import tsx packages/agent-host/scripts/probe-auto-callback.mts
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
              // 어댑터가 하는 것과 같다 — 선택지의 답은 deny의 message로 간다
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
