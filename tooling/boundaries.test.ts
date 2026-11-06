/**
 * Evidence that the boundary rules "actually work" (the completion criterion for M1 plan
 * T0-2). Checks that code violating the documented rules (docs/architecture.md §2,
 * platform-abstraction.md §6) triggers a lint error. Lints a virtual path without creating a
 * file.
 */
import { describe, expect, it } from 'vitest'
import { virtualFileLinter } from './eslint-virtual.test-helpers.js'

const eslint = virtualFileLinter()

async function lint(filePath: string, code: string) {
  const [res] = await eslint.lintText(code, { filePath, warnIgnored: false })
  return res?.messages ?? []
}
const ruleIds = (msgs: { ruleId?: string | null }[]) => msgs.map((m) => m.ruleId)

/*
 * Three guards that read source files lived here, and are lint rules (tooling/eslint-guards.js, #1606): the protocol writes
 * no tool name (`guard/no-tool-names`, #59), the app runtime does not import the sessions that carry it (#97), and the
 * external app runtime borrows only the named physics modules from dev-services (`guard/import-boundary`;
 * dependency-cruiser's `host-app-runtime-physics-only` enforces the same list).
 */

describe('ui layer boundary', () => {
  it('rejects importing a platform implementation', async () => {
    const msgs = await lint(
      'packages/ui/src/x.tsx',
      `import { createWebPlatform } from '@cc/platform/web'\nexport const a = createWebPlatform`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('rejects calling fetch directly', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `export const a = () => fetch('http://x')`)
    expect(msgs.length).toBeGreaterThan(0)
  })

  it('rejects constructing a WebSocket directly', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `export const a = () => new WebSocket('ws://x')`)
    expect(msgs.length).toBeGreaterThan(0)
  })

  it('rejects importing @tauri-apps', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `import { invoke } from '@tauri-apps/api/core'\nexport const a = invoke`)
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('allows importing ports', async () => {
    const msgs = await lint(
      'packages/ui/src/x.tsx',
      `import type { Platform } from '@cc/platform/ports'\nexport type A = Platform`,
    )
    expect(msgs.filter((m) => m.severity === 2)).toEqual([])
  })
})

describe('core layer boundary', () => {
  it('rejects importing node IO', async () => {
    const msgs = await lint(
      'packages/core/src/x.ts',
      `import { readFileSync } from 'node:fs'\nexport const a = readFileSync`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('rejects importing react', async () => {
    const msgs = await lint('packages/core/src/x.ts', `import { useState } from 'react'\nexport const a = useState`)
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('allows importing protocol', async () => {
    const msgs = await lint(
      'packages/core/src/x.ts',
      `import type { SessionState } from '@cc/protocol'\nexport type A = SessionState`,
    )
    expect(msgs.filter((m) => m.severity === 2)).toEqual([])
  })
})

describe('agent-host layer boundary', () => {
  it('rejects importing core (shares only protocol)', async () => {
    const msgs = await lint(
      'packages/agent-host/src/x.ts',
      `import { applyEvent } from '@cc/core'\nexport const a = applyEvent`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })
})

describe('common layer boundary', () => {
  it('rejects importing node IO and react, like core', async () => {
    const io = await lint('packages/common/src/x.ts', `import { readFileSync } from 'node:fs'\nexport const a = readFileSync`)
    expect(ruleIds(io)).toContain('no-restricted-imports')
    const react = await lint('packages/common/src/x.ts', `import { useState } from 'react'\nexport const a = useState`)
    expect(ruleIds(react)).toContain('no-restricted-imports')
  })
})

/*
 * `boundaries/element-types` is the table of docs/architecture.md §2, one allow-list per layer. It judges an import by what
 * it resolves to (tooling/eslint-import-resolver-cc), and for a long time resolved none of the `@cc/*` imports the packages
 * use, so it judged nothing (#1847). One case per layer: what it may import and what it may not. An allowed import is
 * checked next to a refused one, since on its own it passes whether or not the rule reads anything.
 */
describe('layer table (boundaries/element-types)', () => {
  type Style = 'import' | 'export' | 'named-export' | 'dynamic'
  const refused = async (filePath: string, from: string, style: Style = 'import') => {
    const code = {
      import: `import { a } from '${from}'\nexport const b = a`,
      export: `export * from '${from}'`,
      'named-export': `export { a } from '${from}'`,
      dynamic: `export const b = () => import('${from}')`,
    }[style]
    return ruleIds(await lint(filePath, code)).includes('boundaries/element-types')
  }

  it.each([
    { file: 'packages/protocol/src/x.ts', allowed: ['zod', './other.js'], refused: ['@cc/core', '@cc/common', '../../core/src/index.js', '../../core/src', '../../core/src/session'] },
    { file: 'packages/common/src/x.ts', allowed: ['./other.js'], refused: ['@cc/core', '@cc/protocol'] },
    { file: 'packages/core/src/x.ts', allowed: ['@cc/common', '@cc/protocol'], refused: ['@cc/platform/ports', '@cc/ui'] },
    { file: 'packages/platform/src/ports/x.ts', allowed: ['@cc/protocol'], refused: ['@cc/common', '@cc/core'] },
    { file: 'packages/platform/src/web/x.ts', allowed: ['@cc/common', '@cc/platform/ports'], refused: ['@cc/core', '@cc/ui'] },
    { file: 'packages/ui/src/x.tsx', allowed: ['@cc/core', '@cc/platform/ports'], refused: ['@cc/platform/mock', '@cc/platform/tauri'] },
    // a test takes the mock platform (docs/platform-abstraction.md §6), and no other implementation
    { file: 'packages/ui/src/x.test.tsx', allowed: ['@cc/platform/mock', '@cc/core'], refused: ['@cc/platform/tauri'] },
    // `agent-host/src/apps/` is a folder of the host, not the apps layer
    { file: 'packages/agent-host/src/adapters/x.ts', allowed: ['@cc/common', '../../apps/contract.js'], refused: ['@cc/core', '@cc/ui'] },
    { file: 'packages/platform/src/x.ts', allowed: ['@cc/protocol', './ports/index.js'], refused: ['@cc/core', '@cc/ui', './web/index.js'] },
    { file: 'packages/platform/src/web/x.ts', allowed: ['../capabilities.js', '../engine.js'], refused: ['../../../ui/src/index.js'] },
    { file: 'apps/web/src/x.ts', allowed: ['@cc/platform/web', '@cc/ui'], refused: ['../../../packages/agent-host/src/index.js', '../../../packages/agent-host/src'] },
  ])('$file takes only what its row allows', async ({ file, allowed, refused: banned }) => {
    for (const from of banned) expect(await refused(file, from), `${file} importing ${from}`).toBe(true)
    for (const from of allowed) expect(await refused(file, from), `${file} importing ${from}`).toBe(false)
  })

  it('judges a re-export and a dynamic import as it judges an import', async () => {
    for (const style of ['export', 'named-export', 'dynamic'] as const) {
      expect(await refused('packages/protocol/src/x.ts', '@cc/core', style)).toBe(true)
      expect(await refused('packages/core/src/x.ts', '@cc/common', style)).toBe(false)
    }
  })

  it('reads a path below an alias as the alias folder, and refuses an @cc/ specifier that is none', async () => {
    expect(await refused('packages/agent-host/src/x.ts', '@cc/platform/mock/demo')).toBe(true)
    const msgs = await lint('packages/ui/src/x.tsx', "import { a } from '@cc/nowhere'\nexport const b = a")
    expect(msgs.map((m) => m.message).join()).toMatch(/not an alias/)
  })
})
