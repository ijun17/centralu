import { useCallback, useEffect, useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Kbd } from '../../components/primitives.jsx'

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

  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      // 감지에 실패해도 프로젝트 등록은 막지 않는다
      setTools([])
    }
  }, [platform])

  useEffect(() => {
    void detect()
  }, [detect])

  const usable = tools?.filter((t) => t.installed && t.loggedIn) ?? []
  const canStart = usable.length > 0

  return (
    <div className="flex flex-1 items-center justify-center px-8" data-testid="first-run">
      <div className="w-full max-w-lg">
        <h1 className="text-[15px] font-medium tracking-tight text-chalk">Get started</h1>
        <p className="mt-1 text-[12px] text-ash">
          Register a project to run agents in and monitoring begins.
        </p>

        {/* 1단계: 도구 감지 — 하나만 준비돼 있어도 진행할 수 있다 */}
        <section className="mt-6">
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-slate">Agent tools</h2>
          <ul className="mt-2 space-y-1.5">
            {tools === null ? (
              <li className="text-[12px] text-slate">Checking…</li>
            ) : tools.length === 0 ? (
              <li className="text-[12px] text-ash">Could not detect tools</li>
            ) : (
              tools.map((t) => <ToolRow key={t.tool} d={t} optional={canStart} />)
            )}
          </ul>
          <button
            className="mt-2 text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
            onClick={() => void detect()}
            data-testid="redetect"
          >
            Check again
          </button>
        </section>

        {/* 2단계: 프로젝트 등록 */}
        <section className="mt-6">
          <h2 className="text-[11px] uppercase tracking-[0.12em] text-slate">Project</h2>
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
            Choose directory…
            <span className="mt-0.5 block text-[11px] text-slate">
              Agents run in this directory. It does not have to be a git repo.
            </span>
          </button>
        </section>

        {!canStart && tools !== null && tools.length > 0 && (
          <p className="mt-5 text-[11px] leading-relaxed text-ash" data-testid="first-run-blocked">
            No usable tools. Install and log in as shown above, then press Check again.
            You can still register a project now.
          </p>
        )}

        <p className="mt-6 text-[11px] text-slate">
          <Kbd mod /> <Kbd>I</Kbd> shows everything waiting on you, anytime.
        </p>
      </div>
    </div>
  )
}

/**
 * `optional`은 **다른 도구가 이미 준비돼 있다**는 뜻이다.
 *
 * 둘 중 하나만 쓸 수 있으면 앱은 정상이다 (제품 규칙). 그런데 안 쓰는 도구 줄이
 * 준비된 도구 줄과 똑같은 톤으로 "설치하라 / 로그인하라"를 내밀면, 다 갖춰야
 * 시작할 수 있는 것처럼 읽힌다. 그래서 그 경우에는 **할 일이 아니라 선택지로**
 * 적는다 — 알리되, 길을 막는 것처럼 보이지 않게.
 */
function ToolRow({ d, optional }: { d: Detection; optional: boolean }) {
  const ready = d.installed && d.loggedIn
  const hintTone = optional ? 'text-slate' : 'text-ash'
  return (
    <li className="flex items-baseline gap-2 text-[12px]" data-testid={`tool-${d.tool}`}>
      <span className={`w-2.5 shrink-0 text-center text-[9px] ${ready ? 'text-chalk' : 'text-slate'}`}>
        {ready ? '●' : '○'}
      </span>
      <span className={ready ? 'text-chalk' : 'text-ash'}>{d.tool === 'claude' ? 'Claude Code' : 'Codex'}</span>
      <span className="readout text-[11px] text-slate">{d.detail}</span>
      {!ready && (
        <span className={`ml-auto text-[11px] ${hintTone}`} data-testid={`tool-hint-${d.tool}`}>
          {optional && 'Optional — '}
          {d.installed ? (
            <>
              run <code className="font-mono">{LOGIN_HINT[d.tool] ?? `${d.tool} login`}</code> to use it
            </>
          ) : (
            <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px]">
              {INSTALL_HINT[d.tool] ?? 'Install required'}
            </code>
          )}
        </span>
      )}
    </li>
  )
}
