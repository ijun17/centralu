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
