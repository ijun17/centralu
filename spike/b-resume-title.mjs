// 검증 B-2: 세션 제목 조회 + resume으로 대화 연속성 확인
import { query, listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'

const CWD = new URL('./out/sandbox/', import.meta.url).pathname
const prevSessionId = JSON.parse(readFileSync(new URL('./out/a2-dump.json', import.meta.url)))
  .find(m => m.type === 'result').session_id
console.log('이전 세션:', prevSessionId)

// 1) 세션 목록/정보 — 제목이 있는가
try {
  const sessions = await listSessions({ cwd: CWD })
  const arr = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? [])
  console.log('listSessions 개수:', arr.length)
  for (const s of arr.slice(0, 5))
    console.log('  세션:', JSON.stringify(s).slice(0, 250))
} catch (e) { console.log('listSessions 실패:', e.message) }

try {
  const info = await getSessionInfo(prevSessionId, { cwd: CWD })
  console.log('getSessionInfo:', JSON.stringify(info).slice(0, 400))
} catch (e) { console.log('getSessionInfo 실패:', e.message) }

// 2) resume — 이전 대화 기억 확인
async function* promptOnce(text) {
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
}
const q = query({
  prompt: promptOnce('Earlier in this session I asked you to create a file. Reply with ONLY the filename, nothing else.'),
  options: { cwd: CWD, model: 'haiku', maxTurns: 1, resume: prevSessionId, permissionMode: 'default' },
})
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') console.log('resume된 세션 id:', msg.session_id, '(동일?', msg.session_id === prevSessionId + ')')
  if (msg.type === 'assistant')
    for (const b of msg.message?.content ?? []) if (b.type === 'text') console.log('답변:', b.text.trim())
  if (msg.type === 'result') console.log('result:', msg.subtype, '| cost:', msg.total_cost_usd)
}
