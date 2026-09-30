import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
async function run(label: string, mode: string | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-p-'))
  const asked: string[] = []
  let used = false, ran = false
  const q = query({
    prompt: 'Use the Bash tool to run `mkdir -p /tmp/cc-probe-7731 && echo done`. Just run it, no explanation.',
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
  console.log(`  ${label.padEnd(34)} Bash called=${used?'O':'X'} ran=${ran?'O':'X'} our callback=${asked.length?'called':'not called'}`)
  return { used, gated: asked.length > 0 }
}
console.log('\nKeeping the user\'s actual setting (defaultMode=bypassPermissions), compared against a mutating command\n')
const a = await run("permissionMode='default'", 'default')
const b = await run("permissionMode='bypassPermissions'", 'bypassPermissions')
const c = await run('not sent', undefined)
const d = await run('not sent + resolvePermissionModeInCli', 'RESOLVE')
console.log('\nVerdict:')
console.log(a.used && b.used ? `  does 'default' behave differently from bypass: ${a.gated !== b.gated ? '✅ yes → our value actually takes effect' : '❌ no → either our value has no effect, or the setting wins'}` : '  ⚠️ cannot judge (Bash was not called)')
console.log(`  when not sent: ${c.gated ? 'asks (setting ignored)' : 'does not ask'}`)
console.log(`  resolvePermissionModeInCli: ${d.used ? (d.gated ? 'asks → setting still ignored' : '✅ does not ask → the user setting (bypass) took effect') : '⚠️ cannot judge'}`)
process.exit(0)
