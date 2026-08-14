// 검증 A 디버그: 왜 canUseTool이 안 불리는가 — init·tool_use·permission 관련 전문 덤프
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, writeFileSync } from 'node:fs'

const CWD = new URL('./out/sandbox/', import.meta.url).pathname
mkdirSync(CWD, { recursive: true })

async function* promptOnce(text) {
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}

const approvals = []
const all = []

const q = query({
  prompt: promptOnce('Use the Write tool to create a file named hello.txt containing exactly: hi. Then use Bash to run: curl -s http://example.com -o /dev/null -w %{http_code}. Then stop.'),
  options: {
    cwd: CWD,
    model: 'haiku',
    maxTurns: 3,
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      approvals.push({ toolName, input })
      console.log('*** canUseTool 호출됨:', toolName)
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

for await (const msg of q) {
  all.push(msg)
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('INIT permissionMode:', msg.permissionMode)
    console.log('INIT tools:', (msg.tools ?? []).slice(0, 20).join(','))
    console.log('INIT slash/plugins keys:', Object.keys(msg).join(','))
  }
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'tool_use') console.log('TOOL_USE:', b.name, JSON.stringify(b.input).slice(0, 100))
      if (b.type === 'text') console.log('TEXT:', b.text.slice(0, 150))
    }
  }
  if (msg.type === 'user') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        console.log('TOOL_RESULT:', c.slice(0, 150))
      }
    }
  }
}

writeFileSync(new URL('./out/a2-dump.json', import.meta.url), JSON.stringify(all, null, 2))
console.log('\ncanUseTool 총:', approvals.length, '| 전체 메시지:', all.length, '→ out/a2-dump.json')
