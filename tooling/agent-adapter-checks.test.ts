/** `local/agent-adapter-checks` protects the adapter boundary in docs/architecture.md §2. */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = new ESLint({ cwd: ROOT })

async function checks(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
  return (result?.messages ?? []).filter((message) => message.ruleId === 'agent/agent-adapter-checks').map((message) => message.message)
}

describe('agent CLI identity outside adapters', () => {
  it('reports comparisons in host policy and other shipped packages', async () => {
    expect(await checks('packages/agent-host/src/sessions/policy.ts', "export const deferred = tool === 'claude'\n")).toEqual([expect.stringContaining("'claude'")])
    expect(await checks('packages/platform/src/mock/port.ts', "export const p = 'codex' !== tool\n")).toHaveLength(1)
    expect(await checks('apps/web/src/tool.ts', "switch (tool) { case 'claude': return true }\n")).toHaveLength(1)
  })

  it('allows identities inside adapters and the registry', async () => {
    const code = "export const p = tool === 'claude'\n"
    expect(await checks('packages/agent-host/src/adapters/fixture/index.ts', code)).toEqual([])
    expect(await checks('packages/agent-host/src/adapters/registry.ts', code)).toEqual([])
  })

  it('does not mistake a tool label for a CLI identity comparison', async () => {
    expect(await checks('packages/agent-host/src/sessions/policy.ts', "export const p = label === 'Claude Code'\n")).toEqual([])
  })
})
