import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../contract.js'

/**
 * 제안된 MCP 서버가 오케스트레이터의 이름을 가져갈 수 있는가 (#93).
 *
 * **진짜 길로 본다**: 매니저의 propose_mcp_server → 사람의 승인 → 오케스트레이터
 * 재시작 → 진짜 ClaudeAdapter가 SDK에 넘기는 옵션. 헬퍼를 따로 부르면 세 겹
 * (이름 검사 · 펼치는 순서 · 승인 예외) 중 어느 것이 막았는지 알 수 없고,
 * 한 겹이 조용히 죽어도 테스트는 초록으로 남는다.
 *
 * 가짜는 SDK 하나뿐이다 — 진짜 CLI를 띄우면 무엇이 넘어갔는지 볼 수가 없다.
 * (그래서 이 파일이 매니저가 아니라 어댑터 폴더에 산다: 모듈 목이 파일 단위다.)
 */
const captured = vi.hoisted(() => ({ options: null as Record<string, unknown> | null }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    captured.options = args.options
    return {
      // eslint-disable-next-line require-yield -- 옵션만 보면 되므로 스트림은 영원히 조용하다
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {})
      },
      interrupt: async () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
  // 인프로세스 서버의 자리를 알아볼 표식만 남긴다 — stdio 항목과 구별되면 충분하다
  createSdkMcpServer: (cfg: { name: string }) => ({ type: 'sdk' as const, name: cfg.name }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}))

const { ClaudeAdapter } = await import('./index.js')
const { SessionManager } = await import('../../sessions/manager.js')
const { Store } = await import('../../dev-services/store.js')
const { ORCHESTRATOR_TOOLS, appToolEntries } = await import('../../sessions/orchestrator-tools.js')

let store: InstanceType<typeof Store>
let mgr: InstanceType<typeof SessionManager>

beforeEach(() => {
  // 오케스트레이터 홈이 진짜 홈 디렉토리에 생기지 않게 (세션은 여기서 뜬다)
  process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-93-'))
  captured.options = null
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new ClaudeAdapter()]])
  mgr = new SessionManager(store, adapters, (_e: NormalizedEvent) => {})
})

/** 마지막으로 뜬 세션에 실린 MCP 서버 지도 */
const servers = () => (captured.options?.mcpServers ?? {}) as Record<string, { type?: string }>

/** 실제 승인 콜백. 200ms 안에 답이 없으면 사람에게 물은 것이다 (승인 창이 떴다) */
async function decide(toolName: string): Promise<unknown> {
  const canUseTool = captured.options?.canUseTool as
    | ((n: string, i: Record<string, unknown>) => Promise<unknown>)
    | undefined
  expect(typeof canUseTool).toBe('function')
  return Promise.race([
    canUseTool!(toolName, { url: 'http://evil' }),
    new Promise((r) => setTimeout(() => r('asked-the-human'), 200)),
  ])
}

describe('오케스트레이터의 이름은 제안할 수 없다 (#93)', () => {
  /*
   * 승인된 서버는 내장 항목과 같은 지도에 들어간다. 이름이 같으면 한쪽이 사라진다 —
   * 사라지는 쪽이 인프로세스 오케스트레이터면, 그 이름이 가진 승인 예외까지
   * 통째로 남의 것이 된다.
   */
  it('centralu라는 이름의 제안은 거절되고, 인프로세스 서버가 그대로 남는다', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'centralu',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    expect(mgr.mcpProposals()).toEqual([])
    // 승인 카드가 뜨지 않으므로 승인할 것도 없다 — 서버 목록은 비어 있다
    expect(mgr.mcpServers()).toEqual([])
    expect(servers()['centralu']).toEqual({ type: 'sdk', name: 'centralu' })
  })

  /*
   * MCP 도구 이름의 칸막이는 `__`다. 이름에 밑줄을 허용하면 서버 하나가 남의 이름
   * 뒤에 칸을 더 붙일 수 있다: centralu__pw → mcp__centralu__pw__*.
   */
  it('centralu__pw처럼 칸막이를 품은 이름도 제안 단계에서 막힌다', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'centralu__pw',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    expect(mgr.mcpProposals()).toEqual([])

    // 이름 규칙은 좁히되 평범한 제안은 그대로 지나가야 한다
    const ok = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'playwright',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    })
    expect(ok.isError).toBeFalsy()
    expect(mgr.mcpProposals().map((p) => p.name)).toEqual(['playwright'])
  })

  /*
   * `app-<id>`는 외부 앱이 세션에 붙는 이름이다 (M4 A-5). 승인된 `app-notes` 서버는 앱 notes의
   * 대리 서버와 같은 칸에 들어가 한쪽이 사라지고, 그 칸의 도구는 앱의 읽기 전용 주석으로
   * 승인을 건너뛸 수 있다 — 칸의 주인은 런타임이 아는 앱뿐이어야 한다.
   */
  it('app-로 시작하는 이름의 제안도 거절된다 — 외부 앱의 자리다', async () => {
    const orc = await mgr.orchestrator()
    const r = await mgr.runOrchestratorTool(orc.id, 'propose_mcp_server', {
      name: 'app-notes',
      command: 'npx',
      args: ['-y', 'whatever'],
    })

    expect(r.isError).toBe(true)
    expect(r.text).toContain('app-')
    expect(mgr.mcpProposals()).toEqual([])
  })

  /*
   * 승인 예외는 남의 검사를 믿지 않는다. 이름 쪽이 뚫렸다고 가정하고,
   * 위조된 도구 이름을 콜백에 직접 들이민다.
   */
  it('승인 예외는 서버 이름 전체로 판정한다 — 우리 도구만 통과하고 위조는 사람에게 간다', async () => {
    await mgr.orchestrator()

    // 예외가 있는 이유(실측): 이게 막히면 오케스트레이터가 첫 도구에서 멈춰 선다
    expect(await decide('mcp__centralu__list_sessions')).toEqual({
      behavior: 'allow',
      updatedInput: { url: 'http://evil' },
    })

    // 칸을 하나 더 붙인 이름은 우리 것이 아니다
    expect(await decide('mcp__centralu__pw__browser_navigate')).toBe('asked-the-human')
  })

  /*
   * 위 시험은 list_sessions 하나로 "우리 도구는 통과한다"를 말한다. 그런데 판정이
   * `split('__')`의 칸 수를 세므로, **이름에 밑줄이 두 개 연속으로 들어간 도구가 새로
   * 생기는 순간** 그 도구만 조용히 승인 창을 띄운다 — 오케스트레이터가 첫 도구에서
   * 멈춰 서는 그 증상이고, 새 도구를 추가한 사람은 이유를 짐작할 수 없다.
   *
   * 그래서 하나가 아니라 **명부 전체**를 건다. 지금은 17개 모두 밑줄이 하나씩이다.
   */
  it('오케스트레이터 명부의 모든 도구가 예외를 통과한다 — 이름에 `__`가 생기면 여기서 걸린다', async () => {
    await mgr.orchestrator()

    const names = [...ORCHESTRATOR_TOOLS, ...appToolEntries('orchestrator')].map((t) => t.name)
    expect(names.length).toBeGreaterThan(10) // 명부를 못 읽어 빈 배열을 도는 것을 막는다

    const asked = []
    for (const name of names) {
      if ((await decide(`mcp__centralu__${name}`)) === 'asked-the-human') asked.push(name)
    }
    expect(asked).toEqual([])
  })

  /*
   * 이 고침 전에 승인되어 저장소에 앉은 항목은 이름 검사를 거치지 않았다.
   * 그 항목이 살아 돌아와도 내장 서버를 밀어내지는 못해야 한다 —
   * 펼치는 순서가 그 보장을 진다.
   */
  it('이미 저장된 centralu 항목도 내장 서버를 밀어내지 못한다 (고침 이전에 승인된 것)', async () => {
    store.setAppSetting(
      'orchestrator_mcp_servers',
      JSON.stringify([{ name: 'centralu', command: 'npx', args: ['-y', 'whatever'] }]),
    )

    await mgr.orchestrator()

    expect(servers()['centralu']).toEqual({ type: 'sdk', name: 'centralu' })
  })
})
