/**
 * Evidence that the boundary rules "actually work" (the completion criterion for M1 plan
 * T0-2). Checks that code violating the documented rules (docs/architecture.md §2,
 * platform-abstraction.md §6) triggers a lint error. Lints a virtual path without creating a
 * file.
 */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROTOCOL_SRC = join(ROOT, 'packages/protocol/src/')

/** Block and line comments, so prose that explains a rule cannot trip it. */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const eslint = new ESLint({ cwd: ROOT })

async function lint(filePath: string, code: string) {
  const [res] = await eslint.lintText(code, { filePath, warnIgnored: false })
  return res?.messages ?? []
}
const ruleIds = (msgs: { ruleId?: string | null }[]) => msgs.map((m) => m.ruleId)

/**
 * `@cc/protocol` is the shelf both sides can reach, which is exactly why a vendor must not
 * be able to leave anything on it.
 *
 * It used to hold both halves of a tool's identity: `ToolName` was `z.enum(['claude',
 * 'codex'])` and `TOOL_META` beside it carried each one's label, glyph, install command and
 * login command. So a tool existed in three places — the shared protocol, its adapter, and
 * every screen that drew a row per tool — and adding a third (#59) meant finding all of
 * them. An adapter introduces itself now, and this test is what keeps the old shape from
 * growing back one convenient constant at a time.
 *
 * Comments are stripped first: the ones explaining this change name the vendors, and a rule
 * that cannot be explained in the file it governs is a rule that gets deleted.
 */
describe('protocol does not know about vendors', () => {
  const sources = readdirSync(PROTOCOL_SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, code: stripComments(readFileSync(join(PROTOCOL_SRC, f), 'utf8')) }))

  it('has source files to read', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('does not write a tool name into the code', () => {
    const offenders = sources
      .filter(({ code }) => /\b(claude|codex)\b/i.test(code))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})

/** Every `.ts`/`.tsx` under a directory, tests included, with comments stripped. */
function sourcesUnder(dir: string): { file: string; code: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sourcesUnder(path)
    if (!/\.tsx?$/.test(e.name)) return []
    return [{ file: relative(ROOT, path), code: stripComments(readFileSync(path, 'utf8')) }]
  })
}

/** Static, dynamic and re-exported specifiers alike — a leak does not care which form it took. */
function importsOf(code: string): string[] {
  const re = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g
  return [...code.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

/**
 * `apps/` is the layer other things are meant to run *on*, and it was running *beside* them.
 *
 * The UI runtime imported the inbox's store and re-exported `useInbox` from its own pass, so
 * the contract an app author reads had one particular product's word in it — and deleting
 * that product stopped the runtime from compiling. The host half had the same shape one
 * level down: `apps/contract.ts` borrowed `AppToolCaller` from the orchestrator, which is one
 * caller of the runtime, not its owner. Both directions are inverted now: the runtime
 * declares what it needs (`apps/host.ts`) and the host supplies it (`store/app-host.ts`).
 *
 * The cycle grew because nothing was checking. This is the checking (#97), and it is the same
 * rule as the one above, one layer over: a shelf both sides reach must stay one-directional.
 *
 * Comments are stripped first — the prose explaining this names the layers it forbids.
 */
describe('the app runtime does not know what carries it', () => {
  const layers = [
    {
      name: 'packages/ui/src/apps',
      dir: join(ROOT, 'packages/ui/src/apps/'),
      // The two layers of the inbox product. If the runtime called into these, the inbox
      // could never be deleted.
      forbidden: /(^|\/)(store|features)(\/|$)/,
    },
    {
      name: 'packages/agent-host/src/apps',
      dir: join(ROOT, 'packages/agent-host/src/apps/'),
      // The orchestrator is one caller of the runtime — the runtime must not lean on it the
      // other way around.
      forbidden: /(^|\/)sessions(\/|$)/,
    },
  ]

  for (const layer of layers) {
    describe(layer.name, () => {
      const sources = sourcesUnder(layer.dir)

      it('has source files to read', () => {
        expect(sources.length).toBeGreaterThan(0)
      })

      it('does not import a forbidden layer', () => {
        const offenders = sources.flatMap(({ file, code }) =>
          importsOf(code)
            .filter((spec) => layer.forbidden.test(spec))
            .map((spec) => `${file} → ${spec}`),
        )
        expect(offenders).toEqual([])
      })
    })
  }
})

/**
 * The external app runtime (M4 A) is the one part of `apps/` allowed into `dev-services/`, and
 * only by name: folder watching, path containment and killing a process tree are promises the
 * terminal and the command runner already keep, and a second copy of "how we kill a tree" is how
 * the two drift apart.
 * Everything else stays out — sessions and adapters are callers of the runtime, and the store is
 * reached through the `ExternalAppsDeps` the host supplies.
 *
 * dependency-cruiser enforces the same list (`host-app-runtime-physics-only`); this is the copy
 * that runs with the tests, so a widening has to be made twice, on purpose.
 */
describe('the external app runtime borrows only the named physics modules', () => {
  const sources = sourcesUnder(join(ROOT, 'packages/agent-host/src/apps/external/'))
  const PHYSICS = /(^|\/)dev-services\/(watch|path-guard|kill-tree)\.js$/

  it('has source files to read', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('never imports sessions or adapters, and only the allow-listed dev-services', () => {
    const offenders = sources.flatMap(({ file, code }) =>
      importsOf(code)
        .filter(
          (spec) =>
            /(^|\/)(sessions|adapters)(\/|$)/.test(spec) ||
            (/(^|\/)dev-services\//.test(spec) && !PHYSICS.test(spec)),
        )
        .map((spec) => `${file} → ${spec}`),
    )
    expect(offenders).toEqual([])
  })
})

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
