import { useEffect, useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Kbd } from '../../components/primitives.jsx'

type Detection = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

const INSTALL_HINT: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
}

/**
 * 첫 실행 경험 (FR-19, E-1).
 *
 * 처음 여는 사람이 마주하는 세 가지 빈 상태를 실제로 설계한다:
 * CLI 미설치 / 로그인 안 됨 / 프로젝트 0개.
 * 빈 화면은 막다른 길이 아니라 **다음 행동을 알려주는 자리**여야 한다.
 */
export function FirstRun() {
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const setToast = useStore((s) => s.setToast)
  const [tools, setTools] = useState<Detection[] | null>(null)
  const [busy, setBusy] = useState(false)

  const detect = async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }
  useEffect(() => {
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const usable = tools?.filter((t) => t.installed && t.loggedIn) ?? []
  const canStart = usable.length > 0

  return (
    <div className="flex flex-1 items-center justify-center px-8" data-testid="first-run">
      <div className="w-full max-w-lg">
        <h1 className="text-[15px] font-medium tracking-tight text-chalk">시작하기</h1>
        <p className="mt-1 text-[12px] text-ash">
          에이전트를 실행할 프로젝트를 등록하면 관제가 시작됩니다.
        </p>

        {/* 1단계: 도구 감지 — 하나만 준비돼 있어도 진행할 수 있다 */}
        <section className="mt-6">
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-slate">에이전트 도구</h2>
          <ul className="mt-2 space-y-1.5">
            {tools === null ? (
              <li className="text-[12px] text-slate">확인 중…</li>
            ) : tools.length === 0 ? (
              <li className="text-[12px] text-ash">도구를 확인할 수 없습니다</li>
            ) : (
              tools.map((t) => <ToolRow key={t.tool} d={t} />)
            )}
          </ul>
          <button
            className="mt-2 text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
            onClick={() => void detect()}
            data-testid="redetect"
          >
            다시 확인
          </button>
        </section>

        {/* 2단계: 프로젝트 등록 */}
        <section className="mt-6">
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-slate">프로젝트</h2>
          <button
            className="mt-2 w-full rounded border border-edge bg-panel px-3 py-2.5 text-left text-[13px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy}
            data-testid="first-run-pick"
            onClick={async () => {
              setBusy(true)
              try {
                const picked = await platform.system.pickDirectory()
                if (picked) await addProject(picked)
              } catch (e) {
                setToast((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            디렉토리 선택…
            <span className="mt-0.5 block text-[11px] text-slate">
              에이전트가 이 디렉토리에서 실행됩니다. git 저장소가 아니어도 됩니다.
            </span>
          </button>
        </section>

        {!canStart && tools !== null && tools.length > 0 && (
          <p className="mt-5 text-[11px] leading-relaxed text-ash" data-testid="first-run-blocked">
            사용할 수 있는 도구가 없습니다. 위 안내대로 설치·로그인한 뒤 다시 확인을 눌러주세요.
            프로젝트는 지금 등록해 두어도 됩니다.
          </p>
        )}

        <p className="mt-6 text-[11px] text-slate">
          <Kbd>⌘</Kbd> <Kbd>I</Kbd> 는 언제든 기다리는 항목만 모아 보여줍니다.
        </p>
      </div>
    </div>
  )
}

function ToolRow({ d }: { d: Detection }) {
  const ready = d.installed && d.loggedIn
  return (
    <li className="flex items-baseline gap-2 text-[12px]" data-testid={`tool-${d.tool}`}>
      <span className={`w-2.5 shrink-0 text-center text-[9px] ${ready ? 'text-chalk' : 'text-slate'}`}>
        {ready ? '●' : '○'}
      </span>
      <span className={ready ? 'text-chalk' : 'text-ash'}>{d.tool === 'claude' ? 'Claude Code' : 'Codex'}</span>
      <span className="readout text-[11px] text-slate">{d.detail}</span>
      {!d.installed && (
        <code className="ml-auto rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ash">
          {INSTALL_HINT[d.tool] ?? '설치 필요'}
        </code>
      )}
      {d.installed && !d.loggedIn && (
        <span className="ml-auto text-[11px] text-ash">
          터미널에서 <code className="font-mono">{d.tool}</code> 실행 후 로그인
        </span>
      )}
    </li>
  )
}
