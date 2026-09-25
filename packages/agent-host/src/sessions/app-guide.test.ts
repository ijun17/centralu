import { describe, expect, it } from 'vitest'
import type { OrchestratorTools } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import { HOST_APPS } from '../apps/registry.js'
import { APP_GUIDE_TOPICS } from './app-guide.js'
import {
  MANAGER_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  SCOPED_INSTRUCTIONS,
  appToolEntries,
  profileAllows,
  registerAppTools,
  runOrchestratorTool,
} from './orchestrator-tools.js'

/**
 * 안내서가 없는 도구를 말하지 않는다 (M4 P-4).
 *
 * 앱 안내서는 오케스트레이터가 사람에게 앱을 설명할 때 읽는 글이고, M4에서는 앱을 만들
 * 에이전트가 가장 먼저 읽는 글이 된다. 그 글이 보관 기능이 폐기된 뒤(58d2335)에도
 * `archive_session`을 안내하고 있었다 — 오케스트레이터가 그대로 믿고 부르면 "알 수 없는
 * 도구"가 돌아오고, 사람에게는 없는 기능을 설명하게 된다. 관제 앱(#81)의 도구는 반대로
 * 하나도 몰랐다.
 *
 * 자리마다의 도구 목록은 이제 명부에서 만들어지므로 그쪽은 틀릴 수가 없다. 남은 위험은
 * 사람이 쓴 문장 속의 도구 이름이다. 그래서 글 전체에서 도구 이름 모양(snake_case)의
 * 낱말을 모두 뽑아 명부와 대조한다.
 */

/** 명부의 앱 도구를 등록한다 — 매니저가 기동할 때 하는 일과 같은 모양 (enabled만 테스트가 정한다) */
function registerHostApps(enabled: boolean): void {
  registerAppTools(
    HOST_APPS.flatMap((app) => {
      const t = app.tools
      if (!t) return []
      return t.defs.map((d) => ({
        name: d.name,
        description: d.description,
        schema: d.schema,
        profiles: d.profiles ?? t.profiles,
        enabled: () => enabled,
        run: async () => ({ text: '' }),
      }))
    }),
  )
}

/** app_guide는 매니저를 부르지 않는다 — 빈 손잡이로 충분하다 */
const noTools = {} as OrchestratorTools

async function guide(topic?: string): Promise<string> {
  const r = await runOrchestratorTool(noTools, 'app_guide', topic ? { topic } : {})
  expect(r.isError).toBeFalsy()
  return r.text
}

async function wholeGuide(): Promise<string> {
  const parts = [await guide()]
  for (const t of APP_GUIDE_TOPICS) parts.push(await guide(t))
  return parts.join('\n')
}

/** 명부에 있는 모든 도구 이름 — 앱이 꺼져 있어도 이름은 존재한다 */
const KNOWN = new Set<string>([
  ...ORCHESTRATOR_TOOLS.map((t) => t.name),
  ...HOST_APPS.flatMap((a) => a.tools?.defs.map((d) => d.name) ?? []),
])

function toolLikeWords(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])]
}

/** 오케스트레이터 주제에서 한 자리의 목록 부분 */
function seatSection(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = text.indexOf('\n## ', start + 1)
  return text.slice(start, next < 0 ? undefined : next)
}

const SEATS: { profile: ToolProfile; heading: string }[] = [
  { profile: 'orchestrator', heading: '오케스트레이터가 부르는 도구' },
  { profile: 'manager', heading: '워크트리 매니저가 부르는 도구' },
  { profile: 'scoped', heading: '반장이 부르는 도구' },
]

describe('앱 안내서는 명부에 있는 도구만 말한다', () => {
  it('어느 주제에도 명부에 없는 도구 이름이 없다', async () => {
    registerHostApps(true)
    const unknown = toolLikeWords(await wholeGuide()).filter((w) => !KNOWN.has(w))
    expect(unknown).toEqual([])
  })

  it('모델에게 주는 안내문도 같다', () => {
    const text = [ORCHESTRATOR_INSTRUCTIONS, MANAGER_INSTRUCTIONS, SCOPED_INSTRUCTIONS].join('\n')
    expect(toolLikeWords(text).filter((w) => !KNOWN.has(w))).toEqual([])
  })

  it('자리마다 그 자리가 부를 수 있는 도구를 빠짐없이 적는다 — 앱 도구 포함', async () => {
    registerHostApps(true)
    const text = await guide('orchestrator')
    for (const { profile, heading } of SEATS) {
      const section = seatSection(text, heading)
      const allowed = [
        ...ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name)).map((t) => t.name),
        ...appToolEntries(profile).map((t) => t.name),
      ]
      expect(allowed.length).toBeGreaterThan(0)
      expect(allowed.filter((n) => !section.includes(`- ${n}:`))).toEqual([])
    }
    // 관제 앱의 도구가 실제로 실렸다는 것 — 위 단언이 빈 앱 목록으로 통과하지 않게
    expect(text).toContain('- control_create_task:')
  })

  it('꺼진 앱의 도구는 안내하지 않는다 — 부르면 거절될 도구다', async () => {
    registerHostApps(false)
    const text = await guide('orchestrator')
    const appTools = HOST_APPS.flatMap((a) => a.tools?.defs.map((d) => d.name) ?? [])
    expect(appTools.length).toBeGreaterThan(0)
    expect(appTools.filter((n) => text.includes(`- ${n}:`))).toEqual([])
    // 코어 도구는 그대로 남는다
    expect(text).toContain('- list_sessions:')
  })
})
