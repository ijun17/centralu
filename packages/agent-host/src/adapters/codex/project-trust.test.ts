import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionPreset } from '@cc/protocol'
import type { OrchestratorTools } from '../contract.js'

/**
 * 신뢰하지 않은 프로젝트의 파일은 Codex 스레드에 닿지 않는다 (M4 결정 3, #92).
 *
 * 이 계약의 전부가 "스레드를 띄울 때 무엇을 보냈는가"다(verbosity.test.ts와 같은 방식). Codex가 그
 * 값으로 무엇을 하는지는 소스와 0.153.4 바이너리로만 확인했다(로그아웃 — repoFilesConfig의 주석).
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const paramsOf = (method: string) => state.requests.find((r) => r.method === method)?.params as Record<string, unknown>
const configOf = (method: string) => paramsOf(method).config as Record<string, unknown>

let cwd: string
beforeEach(() => {
  state.requests.length = 0
  // macOS의 임시 폴더는 /var → /private/var 심볼릭 링크 아래다 — 두 철자가 갈리는 실제 경우
  cwd = mkdtempSync(join(tmpdir(), 'cc-codex-trust-'))
})

const start = (permissionPreset: PermissionPreset, projectTrusted: boolean | undefined, extra: Record<string, unknown> = {}) =>
  new CodexAdapter().createSession({ sessionId: 's1', cwd, permissionPreset, projectTrusted, ...extra }, () => {})

const PRESET: Record<PermissionPreset, Record<string, unknown>> = {
  safe: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  normal: {},
  auto: { approvalPolicy: 'never', sandbox: 'workspace-write' },
}

function ancestors(p: string): string[] {
  const out: string[] = []
  for (let d = p; ; d = dirname(d)) {
    out.push(d)
    if (dirname(d) === d) return out
  }
}

describe('Codex 스레드에 저장소의 파일이 닿는가 (#92)', () => {
  for (const preset of ['safe', 'normal', 'auto'] as const) {
    it(`${preset}: 신뢰하지 않은 프로젝트는 그 폴더와 조상 전부를 이 스레드에서만 "untrusted"로 적는다 — 권한 옵션은 같다`, async () => {
      await start(preset, false)
      const params = paramsOf('thread/start')
      const config = configOf('thread/start')
      // 적힌 철자와 실제 경로(심볼릭 링크를 푼 것) 둘 다, 뿌리까지
      const keys = [...new Set([...ancestors(cwd), ...ancestors(realpathSync.native(cwd))])]
      expect(config.projects).toEqual(Object.fromEntries(keys.map((k) => [k, { trust_level: 'untrusted' }])))
      expect(config.project_doc_max_bytes).toBe(0)
      // 프리셋의 권한 매핑은 신뢰와 무관하다 — normal은 여전히 사용자의 ~/.codex/config.toml을 따른다
      expect({ approvalPolicy: params.approvalPolicy, sandbox: params.sandbox }).toEqual({
        approvalPolicy: PRESET[preset].approvalPolicy,
        sandbox: PRESET[preset].sandbox,
      })
    })

    it(`${preset}: 신뢰한 프로젝트는 지금과 같다 — 신뢰도 문서 상한도 싣지 않는다`, async () => {
      await start(preset, true)
      const params = paramsOf('thread/start')
      const config = configOf('thread/start')
      expect(config.projects).toBeUndefined()
      expect(config.project_doc_max_bytes).toBeUndefined()
      expect({ approvalPolicy: params.approvalPolicy, sandbox: params.sandbox }).toEqual({
        approvalPolicy: PRESET[preset].approvalPolicy,
        sandbox: PRESET[preset].sandbox,
      })
    })
  }

  it('재개에도 같은 판정이 실린다 — 잠들었다 깨면 저장소의 설정이 살아나면 안 된다', async () => {
    await start('normal', false, { resumeExternalId: 'ext-1' })
    const config = configOf('thread/resume')
    expect(config.projects).toMatchObject({ [cwd]: { trust_level: 'untrusted' } })
    expect(config.project_doc_max_bytes).toBe(0)

    state.requests.length = 0
    await start('normal', true, { resumeExternalId: 'ext-1' })
    expect(configOf('thread/resume').projects).toBeUndefined()
  })

  it('신뢰를 모르면 신뢰하지 않은 것이다 — 프로젝트가 없는 오케스트레이터도 그 폴더를 "untrusted"로 띄운다', async () => {
    await start('normal', undefined, {
      orchestratorTools: {} as OrchestratorTools,
      orchestratorBridge: { url: 'ws://127.0.0.1:1', token: 't' },
    })
    const config = configOf('thread/start')
    expect(config.projects).toMatchObject({ [cwd]: { trust_level: 'untrusted' } })
    expect(config.project_doc_max_bytes).toBe(0)
    expect(config.mcp_servers).toBeDefined() // 한 덩어리로 합쳐졌다 — 서로를 덮지 않는다
  })
})
