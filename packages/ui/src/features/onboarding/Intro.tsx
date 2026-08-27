import { useCallback, useEffect, useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'

type Detection = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

const INSTALL_HINT: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
}

// 로그인 명령이 도구마다 다르다 — 틀린 명령을 적으면 안내가 아니라 함정이다
const LOGIN_HINT: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
}

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * 소개 화면 (#63) — 첫 실행에 딱 한 번, "네 오케스트레이터를 만나라".
 *
 * FirstRun(폴더 먼저)을 대체한다. 이유는 효율이 아니라 **습관**이다: 첫 실행에서
 * 오케스트레이터에게 물어보는 경험을 겪지 않은 사람은 나중에도 누르지 않는다 —
 * 사람은 자기가 써 본 것만 쓴다. 이 앱의 질문 창구는 제작자가 아니라 오케스트레이터다.
 *
 * **카드가 곧 감지 표시다.** 도구 감지 화면을 따로 두지 않는다 — 준비된 도구는 살아
 * 있는 카드, 안 된 도구는 어두운 카드에 "Not connected"와 처방(설치·로그인 명령)이
 * 함께 선다. 상태를 보여주는 곳과 행동하는 곳이 같은 자리다.
 *
 * **카드 클릭은 설정을 적을 뿐, 프로세스는 뜨지 않는다** (지연 기동). 오케스트레이터가
 * 실제로 태어나는 것은 다음 화면에서 첫 질문이 던져지는 순간이다.
 */
export function Intro() {
  const platform = usePlatform()
  const completeIntro = useStore((s) => s.completeIntro)
  const [tools, setTools] = useState<Detection[] | null>(null)

  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }, [platform])

  useEffect(() => {
    void detect()
  }, [detect])

  const ready = (t: Detection) => t.installed && t.loggedIn
  const anyReady = (tools ?? []).some(ready)
  // 목록에 없어도 두 도구의 카드는 선다 — "없다"도 카드가 말할 상태다
  const cards: Detection[] = (['claude', 'codex'] as ToolName[]).map(
    (tool) =>
      tools?.find((t) => t.tool === tool) ?? { tool, installed: false, loggedIn: false, detail: 'not found' },
  )

  return (
    <div className="flex flex-1 items-center justify-center px-8" data-testid="intro">
      <div className="w-full max-w-xl">
        {/*
          **한 줄이 전부다.** 세 문단짜리 설명을 읽고 시작하는 사람은 없다 —
          길수록 안 읽히고, 안 읽히면 이 화면은 아무것도 가르치지 못한 채 클릭
          하나만 받아 간다 (도그푸딩 지적). 남길 문장은 이 화면이 존재하는 이유
          하나: **말을 걸 상대가 있다.** 나머지는 다음 화면의 질문 카드가 한다.
        */}
        <h1 className="text-[19px] font-medium tracking-tight text-chalk" data-testid="intro-role">
          Meet your <span className="text-chalk">orchestrator</span>.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ash">
          It watches every session and answers whatever you ask about this app.
        </p>
        <p className="mt-5 text-[12px] text-slate">Run it on:</p>

        <div className="mt-2 grid grid-cols-2 gap-3">
          {cards.map((t) => {
            const ok = ready(t)
            return (
              <button
                key={t.tool}
                data-testid={`intro-card-${t.tool}`}
                disabled={!ok}
                onClick={() => void completeIntro(t.tool)}
                /*
                 * 비활성은 **어둡게** (사용자 요구) — 회색 글자는 "지금 없는 것"의
                 * 관습이고, 여기서는 그 관습이 정확히 사실이다.
                 */
                className={`rounded-lg border px-4 py-4 text-left transition-colors ${
                  ok
                    ? 'border-edge bg-panel hover:border-graphite'
                    : 'cursor-not-allowed border-edge/60 bg-panel/40 opacity-40'
                }`}
              >
                <span className="block text-[14px] font-medium text-chalk">{TOOL_LABEL[t.tool]}</span>
                {ok ? (
                  <span className="readout mt-1 block text-[11px] text-slate">{t.detail}</span>
                ) : (
                  <>
                    {/* 진단은 한눈에, 처방은 그 아래 — 터미널을 모르는 눈이 먼저다 */}
                    <span className="mt-1 block text-[12px] text-ash" data-testid={`intro-card-${t.tool}-status`}>
                      Not connected
                    </span>
                    <code className="mt-1.5 block truncate rounded bg-pit px-1.5 py-1 font-mono text-[10px] text-slate">
                      {t.installed ? (LOGIN_HINT[t.tool] ?? `${t.tool} login`) : (INSTALL_HINT[t.tool] ?? 'Install required')}
                    </code>
                  </>
                )}
              </button>
            )
          })}
        </div>

        {/* 낮은 부담이 클릭을 만든다 — 이 선택은 못을 박는 것이 아니다 */}
        <p className="mt-2 text-[11px] text-slate">You can change this later in Settings.</p>

        {tools === null ? (
          <p className="mt-4 text-[11px] text-slate">Looking for Claude Code and Codex…</p>
        ) : (
          <>
            {!anyReady && (
              <p className="mt-4 text-[11px] leading-relaxed text-ash" data-testid="intro-blocked">
                No tool is ready yet — run a command above in your terminal, then check again.
              </p>
            )}
            {/* 항상 있다 — 터미널에서 설치하고 돌아온 사람이 다시 감지할 길 */}
            <button
              className="mt-1.5 text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
              onClick={() => void detect()}
              data-testid="redetect"
            >
              Check again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
