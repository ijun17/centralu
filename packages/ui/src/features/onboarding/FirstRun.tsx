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

/**
 * 첫 실행 경험 (FR-19, E-1).
 *
 * 처음 여는 사람이 마주하는 세 가지 빈 상태를 실제로 설계한다:
 * CLI 미설치 / 로그인 안 됨 / 프로젝트 0개.
 * 빈 화면은 막다른 길이 아니라 **다음 행동을 알려주는 자리**여야 한다.
 *
 * **이 화면은 앱이 무엇인지 말하고, 첫 대화까지 데려간다** (2026-08-27 흐름 점검).
 * 예전에는 둘 다 못 했다: 첫 줄이 "프로젝트를 등록하면 관제가 시작된다"라는 조작
 * 설명이라 이 앱이 무엇을 하는 물건인지는 어디에도 없었고, 등록하는 순간 화면이
 * 사라져(App이 프로젝트 유무로 가른다) 사람은 빈 화면과 사이드바 앞에 남겨졌다 —
 * 성공의 순간에 다음 걸음이 없었다. 이제 프로젝트가 생기면 세션 생성 창을 예약한다.
 *
 * 도구 감지 목록은 **문제가 있을 때만 앞에 선다.** 여기서 고칠 수 있는 것이 하나도
 * 없는 체크리스트(설치·로그인은 터미널의 일이다)가 첫인상의 무게를 가져가면 안 된다.
 */
export function FirstRun() {
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const openNewSession = useStore((s) => s.openNewSession)
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
        {/*
          **무엇을 하는 물건인지 먼저 말한다.** 여기 오는 사람은 Claude Code나 Codex를
          터미널에서 써 본 사람이고, 이 앱을 여는 이유는 "그걸 여러 개 동시에" 하기
          위해서다. 조작법("디렉토리를 등록하라")은 그 다음이다 — 버튼이 이미 말한다.
        */}
        <h1 className="text-[15px] font-medium tracking-tight text-chalk">
          Keep several agents working. Step in when one needs you.
        </h1>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ash">
          Centralu runs your Claude Code and Codex sessions side by side, and brings the ones that
          are waiting on an answer to you. Pick a folder to work in — that is all the setup there is.
        </p>

        <button
          className="mt-5 w-full rounded border border-edge bg-panel px-3 py-2.5 text-left text-[13px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
          disabled={busy}
          data-testid="first-run-pick"
          onClick={async () => {
            setBusy(true)
            try {
              const picked = await platform.system.pickDirectory()
              /*
               * 등록하는 순간 이 화면은 사라진다 — 다음 걸음을 여기서 예약해 두지
               * 않으면 사람은 빈 화면 앞에 남는다. 창은 사이드바의 그 프로젝트 칸에서
               * 열린다: 앞으로 세션을 만들 때마다 열릴 바로 그 자리다.
               */
              if (picked) openNewSession((await addProject(picked)).id)
            } catch (e) {
              setToast((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          Choose a folder…
          <span className="mt-0.5 block text-[11px] text-slate">
            Agents run here. It does not have to be a git repo, and you can add more later.
          </span>
        </button>

        {/*
          도구 상태는 **문제일 때만 앞에 선다.** 하나라도 쓸 수 있으면 이 목록에서
          할 일은 없다 — 접어 두고, 준비됐다는 사실만 한 줄로 알린다.
        */}
        <section className="mt-6">
          {tools === null ? (
            <p className="text-[11px] text-slate">Looking for Claude Code and Codex…</p>
          ) : canStart ? (
            <details data-testid="first-run-tools">
              <summary className="cursor-pointer list-none text-[11px] text-slate hover:text-ash">
                {usable.map((t) => (t.tool === 'claude' ? 'Claude Code' : 'Codex')).join(' · ')} ready ·
                <span className="ml-1 underline-offset-2 hover:underline">see all tools</span>
              </summary>
              <ul className="mt-2 space-y-1.5">
                {tools.map((t) => (
                  <ToolRow key={t.tool} d={t} optional />
                ))}
              </ul>
            </details>
          ) : (
            <div data-testid="first-run-blocked">
              <p className="text-[11px] leading-relaxed text-ash">
                {tools.length === 0
                  ? 'Could not detect any agent tool. Install one, then press Check again.'
                  : 'No tool is ready yet — install or log in below, then press Check again. You can pick a folder now either way.'}
              </p>
              <ul className="mt-2 space-y-1.5">
                {tools.map((t) => (
                  <ToolRow key={t.tool} d={t} optional={false} />
                ))}
              </ul>
            </div>
          )}
          {tools !== null && (
            <button
              className="mt-2 text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
              onClick={() => void detect()}
              data-testid="redetect"
            >
              Check again
            </button>
          )}
        </section>
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
