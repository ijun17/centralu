/**
 * 경계 규칙이 "실제로 작동한다"는 증거 (M1 플랜 T0-2 완료 기준).
 * 문서에 적힌 규칙(docs/architecture.md §2, platform-abstraction.md §6)을
 * 위반하는 코드가 lint 에러를 내는지 검사한다. 파일을 만들지 않고 가상 경로로 린트한다.
 */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname })

async function lint(filePath: string, code: string) {
  const [res] = await eslint.lintText(code, { filePath, warnIgnored: false })
  return res?.messages ?? []
}
const ruleIds = (msgs: { ruleId?: string | null }[]) => msgs.map((m) => m.ruleId)

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
