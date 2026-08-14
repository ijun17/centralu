// 검증 A: 세션 단위 권한 제어가 전역 bypassPermissions를 덮어쓰는가
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'node:fs'

const CWD = new URL('./out/sandbox/', import.meta.url).pathname
mkdirSync(CWD, { recursive: true })

async function* promptOnce(text) {
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

async function runCase(name, extraOptions) {
  const approvals = []
  const seen = []
  let resultInfo = null

  const q = query({
    prompt: promptOnce('Use the Bash tool to run exactly this command: echo M0_SPIKE_OK. Then stop.'),
    options: {
      cwd: CWD,
      model: 'haiku',
      maxTurns: 3,
      // allowedTools에 bare 도구명을 넣으면 canUseTool이 셰도잉됨 (SDK 경고로 확인) — 넣지 않는다
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        approvals.push({ toolName, input })
        return { behavior: 'allow', updatedInput: input }
      },
      ...extraOptions,
    },
  })

  try {
    for await (const msg of q) {
      seen.push(msg.type + (msg.subtype ? ':' + msg.subtype : ''))
      if (msg.type === 'result') {
        resultInfo = {
          subtype: msg.subtype,
          total_cost_usd: msg.total_cost_usd,
          usage: msg.usage,
          num_turns: msg.num_turns,
          session_id: msg.session_id,
        }
      }
    }
  } catch (e) {
    console.log(`[${name}] ERROR:`, e.message)
  }

  console.log(`\n=== ${name} ===`)
  console.log('messages:', seen.join(', '))
  console.log('canUseTool 호출 횟수:', approvals.length)
  for (const a of approvals) console.log('  →', a.toolName, JSON.stringify(a.input).slice(0, 120))
  console.log('result:', JSON.stringify(resultInfo, null, 2)?.slice(0, 600))
  return { approvals, resultInfo }
}

// A1: SDK 기본 (전역 설정 미로드) + permissionMode default
await runCase('A1: settingSources 기본(미로드)', {})

// A2: 전역 설정 로드 (bypassPermissions 포함) + permissionMode default
await runCase('A2: settingSources [user] (전역 bypass 로드)', { settingSources: ['user'] })

console.log('\nDONE')
