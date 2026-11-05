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
 * it resolves to (tooling/eslint-alias-resolver.cjs), and for a long time resolved none of the `@cc/*` imports the packages
 * use, so it judged nothing (#1847). Each row is an import and whether the table allows it.
 */
describe('layer table (boundaries/element-types)', () => {
  const refused = async (filePath: string, from: string) =>
    ruleIds(await lint(filePath, `import { a } from '${from}'\nexport const b = a`)).includes('boundaries/element-types')

  it.each([
    ['packages/protocol/src/x.ts', '@cc/core'],
    ['packages/protocol/src/x.ts', '@cc/common'],
    ['packages/common/src/x.ts', '@cc/core'],
    ['packages/common/src/x.ts', '@cc/protocol'],
    ['packages/core/src/x.ts', '@cc/platform/ports'],
    ['packages/platform/src/ports/x.ts', '@cc/common'],
    ['packages/platform/src/web/x.ts', '@cc/core'],
    ['packages/ui/src/x.tsx', '@cc/platform/mock'],
    // a test takes the mock platform only
    ['packages/ui/src/x.test.tsx', '@cc/platform/tauri'],
    ['packages/agent-host/src/x.ts', '@cc/core'],
    ['packages/agent-host/src/x.ts', '@cc/ui'],
    // a path into another layer's folder is the same import
    ['packages/protocol/src/x.ts', '../../core/src/index.js'],
  ])('refuses %s importing %s', async (filePath, from) => {
    expect(await refused(filePath, from)).toBe(true)
  })

  it('refuses a re-export and a dynamic import as it refuses an import', async () => {
    expect(await refused('packages/protocol/src/x.ts', '@cc/core', 'export')).toBe(true)
    expect(await refused('packages/protocol/src/x.ts', '@cc/core', 'dynamic')).toBe(true)
    expect(await refused('packages/core/src/x.ts', '@cc/common', 'export')).toBe(false)
  })

  it('reads a path below an alias as the alias folder, and refuses an @cc/ specifier that is none', async () => {
    expect(await refused('packages/agent-host/src/x.ts', '@cc/platform/mock/demo')).toBe(true)
    const code = "import { a } from '@cc/nowhere'\nexport const b = a"
    const msgs = await lint('packages/ui/src/x.tsx', code)
    expect(msgs.map((m) => m.message).join()).toMatch(/not an alias/)
  })

  it.each([
    ['packages/core/src/x.ts', '@cc/common'],
    ['packages/core/src/x.ts', '@cc/protocol'],
    ['packages/platform/src/web/x.ts', '@cc/common'],
    ['packages/platform/src/web/x.ts', '@cc/platform/ports'],
    ['packages/ui/src/x.tsx', '@cc/core'],
    ['packages/ui/src/x.tsx', '@cc/platform/ports'],
    ['packages/agent-host/src/x.ts', '@cc/common'],
    ['apps/web/src/x.ts', '@cc/platform/web'],
    // a test takes the mock platform (docs/platform-abstraction.md §6)
    ['packages/ui/src/x.test.tsx', '@cc/platform/mock'],
    // what lies in a folder named `apps` below a package is not the apps layer
    ['packages/agent-host/src/adapters/x.ts', '../../apps/contract.js'],
    ['packages/protocol/src/x.ts', './other.js'],
    ['packages/protocol/src/x.ts', 'zod'],
  ])('allows %s importing %s', async (filePath, from) => {
    expect(await refused(filePath, from)).toBe(false)
  })
})
