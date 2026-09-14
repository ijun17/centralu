/**
 * 경계 규칙이 "실제로 작동한다"는 증거 (M1 플랜 T0-2 완료 기준).
 * 문서에 적힌 규칙(docs/architecture.md §2, platform-abstraction.md §6)을
 * 위반하는 코드가 lint 에러를 내는지 검사한다. 파일을 만들지 않고 가상 경로로 린트한다.
 */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PROTOCOL_SRC = join(ROOT, 'packages/protocol/src/')

/** Block and line comments, so prose that explains a rule cannot trip it. */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname })

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
describe('protocol은 벤더를 모른다', () => {
  const sources = readdirSync(PROTOCOL_SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, code: stripComments(readFileSync(join(PROTOCOL_SRC, f), 'utf8')) }))

  it('읽을 소스가 있다', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it('코드에 도구 이름을 적지 않는다', () => {
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
describe('앱 런타임은 자기가 태우는 것을 모른다', () => {
  const layers = [
    {
      name: 'packages/ui/src/apps',
      dir: join(ROOT, 'packages/ui/src/apps/'),
      // 인박스 제품의 두 층. 런타임이 이쪽을 부르면 인박스를 지울 수 없다
      forbidden: /(^|\/)(store|features)(\/|$)/,
    },
    {
      name: 'packages/agent-host/src/apps',
      dir: join(ROOT, 'packages/agent-host/src/apps/'),
      // 오케스트레이터는 런타임의 호출자 중 하나다 — 런타임이 거꾸로 기대면 안 된다
      forbidden: /(^|\/)sessions(\/|$)/,
    },
  ]

  for (const layer of layers) {
    describe(layer.name, () => {
      const sources = sourcesUnder(layer.dir)

      it('읽을 소스가 있다', () => {
        expect(sources.length).toBeGreaterThan(0)
      })

      it('금지된 층을 임포트하지 않는다', () => {
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

describe('ui 레이어 경계', () => {
  it('platform 구현체 import를 거부한다', async () => {
    const msgs = await lint(
      'packages/ui/src/x.tsx',
      `import { createWebPlatform } from '@cc/platform/web'\nexport const a = createWebPlatform`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('fetch 직접 호출을 거부한다', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `export const a = () => fetch('http://x')`)
    expect(msgs.length).toBeGreaterThan(0)
  })

  it('WebSocket 직접 생성을 거부한다', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `export const a = () => new WebSocket('ws://x')`)
    expect(msgs.length).toBeGreaterThan(0)
  })

  it('@tauri-apps import를 거부한다', async () => {
    const msgs = await lint('packages/ui/src/x.tsx', `import { invoke } from '@tauri-apps/api/core'\nexport const a = invoke`)
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('ports import는 허용한다', async () => {
    const msgs = await lint(
      'packages/ui/src/x.tsx',
      `import type { Platform } from '@cc/platform/ports'\nexport type A = Platform`,
    )
    expect(msgs.filter((m) => m.severity === 2)).toEqual([])
  })
})

describe('core 레이어 경계', () => {
  it('node IO import를 거부한다', async () => {
    const msgs = await lint(
      'packages/core/src/x.ts',
      `import { readFileSync } from 'node:fs'\nexport const a = readFileSync`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('react import를 거부한다', async () => {
    const msgs = await lint('packages/core/src/x.ts', `import { useState } from 'react'\nexport const a = useState`)
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })

  it('protocol import는 허용한다', async () => {
    const msgs = await lint(
      'packages/core/src/x.ts',
      `import type { SessionState } from '@cc/protocol'\nexport type A = SessionState`,
    )
    expect(msgs.filter((m) => m.severity === 2)).toEqual([])
  })
})

describe('agent-host 레이어 경계', () => {
  it('core import를 거부한다 (protocol만 공유)', async () => {
    const msgs = await lint(
      'packages/agent-host/src/x.ts',
      `import { applyEvent } from '@cc/core'\nexport const a = applyEvent`,
    )
    expect(ruleIds(msgs)).toContain('no-restricted-imports')
  })
})
