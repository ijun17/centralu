import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
async function run(label: string, mode: string | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-p-'))
  const asked: string[] = []
  let used = false, ran = false
  const q = query({
    prompt: 'Bash 도구로 `mkdir -p /tmp/cc-probe-7731 && echo done` 을 실행해줘. 설명 없이 실행만.',
    options: { cwd, ...(mode === 'RESOLVE' ? { resolvePermissionModeInCli: true } : mode ? { permissionMode: mode } : {}),
      canUseTool: async (n: string, i: Record<string, unknown>) => { asked.push(n); return { behavior: 'allow' as const, updatedInput: i } },
    } as never,
  })
  for await (const msg of q) {
    const m = msg as Record<string, unknown>
    if (m.type === 'assistant') for (const c of ((m.message as {content?:unknown[]})?.content ?? [])) {
      const b = c as Record<string, unknown>; if (b.type === 'tool_use' && b.name === 'Bash') used = true }
    if (m.type === 'user') for (const c of ((m.message as {content?:unknown[]})?.content ?? [])) {
      const b = c as Record<string, unknown>; if (b.type === 'tool_result' && JSON.stringify(b.content).includes('done')) ran = true }
    if (m.type === 'result') break
  }
  console.log(`  ${label.padEnd(34)} Bash호출=${used?'O':'X'} 실행=${ran?'O':'X'} 우리콜백=${asked.length?'불림':'안불림'}`)
  return { used, gated: asked.length > 0 }
}
console.log('\n사용자 실제 설정(defaultMode=bypassPermissions) 그대로, 변이 명령으로 비교\n')
const a = await run("permissionMode='default'", 'default')
const b = await run("permissionMode='bypassPermissions'", 'bypassPermissions')
const c = await run('안 보냄', undefined)
const d = await run('안 보냄 + resolvePermissionModeInCli', 'RESOLVE')
console.log('\n판정:')
console.log(a.used && b.used ? `  'default'와 bypass가 다르게 동작하나: ${a.gated !== b.gated ? '✅ 다르다 → 우리 값이 실제로 먹는다' : '❌ 같다 → 우리 값이 안 먹거나 설정이 이긴다'}` : '  ⚠️ 판정 불가 (Bash 미호출)')
console.log(`  안 보냈을 때: ${c.gated ? '물음 (설정 무시)' : '안 물음'}`)
console.log(`  resolvePermissionModeInCli: ${d.used ? (d.gated ? '물음 → 설정 여전히 무시' : '✅ 안 물음 → 사용자 설정(bypass)이 살아났다') : '⚠️ 판정 불가'}`)
process.exit(0)
