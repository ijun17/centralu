/**
 * 실측: 두 도구가 정말 모델 목록을 주는가.
 *
 * UI에서 "기본"만 보인다는 신고가 있었는데, 원인이 어댑터인지 RPC인지 UI인지
 * 화면만 봐서는 알 수 없다. 어댑터를 직접 불러 어느 층에서 끊기는지 가른다.
 */
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { CodexAdapter } from '../src/adapters/codex/index.js'

const cwd = process.cwd()

async function tryClaude() {
  const a = new ClaudeAdapter()
  console.log('\n── claude ──')
  try {
    console.log('세션 없이:', (await a.listModels()).length, '개')
  } catch (e) {
    console.log('세션 없이: 실패 —', (e as Error).message)
  }
  // 세션을 하나 띄우고 다시
  const h = await a.createSession(
    { sessionId: 'smoke', cwd, permissionPreset: 'auto' },
    () => {},
  )
  await new Promise((r) => setTimeout(r, 1500))
  try {
    const models = await a.listModels()
    console.log('세션 뜬 뒤:', models.length, '개')
    for (const m of models) console.log('  ', m.id, '|', m.label, '| efforts:', m.efforts.join(',') || '없음')
  } catch (e) {
    console.log('세션 뜬 뒤: 실패 —', (e as Error).message)
  }
  await h.dispose()
}

async function tryCodex() {
  const a = new CodexAdapter()
  console.log('\n── codex ──')
  try {
    const models = await a.listModels()
    console.log(models.length, '개')
    for (const m of models) console.log('  ', m.id, '|', m.label, '| efforts:', m.efforts.join(',') || '없음')
  } catch (e) {
    console.log('실패 —', (e as Error).message)
  }
}

await tryClaude()
await tryCodex()
process.exit(0)
