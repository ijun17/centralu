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

  it.each([
    ["array membership", "['codex'].includes(tool)", 1],
    ["set membership", "new Set(['codex']).has(tool)", 1],
    ["object lookup", "({ codex: 1 })[tool]", 1],
    ["quoted object key", "({ 'codex': 1 })[tool]", 1],
    ["computed object key", "({ [`codex`]: 1 })[tool]", 1],
    ["template comparison", "tool === `codex`", 1],
    ["constant alias", "const CODEX = 'codex'; tool === CODEX", 1],
    ["regexp test", "/^codex$/.test(tool)", 1],
    ["schema enum", "z.enum(['claude', 'codex'])", 2],
    ["inequality", "tool != 'claude'", 1],
    ["object method", "({ codex() {} })", 1],
  ])('reports %s identities without depending on the surrounding expression', async (_hole, code, count) => {
    expect(await checks('packages/agent-host/src/sessions/policy.ts', code)).toHaveLength(count)
  })

  it('checks .mts app source files', async () => {
    expect(await checks('apps/web/src/tool.mts', "export const tool = 'codex'\n")).toHaveLength(1)
  })

  it('allows CLI fixtures in tests and explained eslint-disable lines', async () => {
    const code = "export const tool = 'codex'\n"
    expect(await checks('packages/agent-host/src/sessions/policy.test.ts', code)).toEqual([])
    expect(await checks('apps/web/src/tool.test.mts', code)).toEqual([])
    expect(await checks('packages/platform/src/mock/demo.ts',
      '// eslint-disable-next-line agent/agent-adapter-checks -- The demo names the CLI it depicts.\n' + code)).toEqual([])
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
