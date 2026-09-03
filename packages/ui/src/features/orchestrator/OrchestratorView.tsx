import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { SessionPane } from '../session/SessionView.jsx'

/**
 * 오케스트레이터 화면 — **말로 관제**.
 *
 * 세션이 있으면 SessionPane을 그대로 쓴다. 그리드의 칸도, 포커스 뷰도
 * 같은 부품이다 — 복사본을 두면 한쪽에서 모델을 바꿨을 때 다른 쪽이 옛 값을 든다.
 *
 * **세션이 없으면 빈 대화가 첫 질문을 기다린다** (#63). 화면을 여는 것은 프로세스를
 * 만들지 않는다 — 만드는 것은 질문 카드를 누르거나 입력창에 첫 마디를 치는 순간이다
 * (askOrchestrator). 그 전의 이 화면은 그저 "말을 걸 수 있는 자리"를 보여줄 뿐이다.
 *
 * 추천 질문은 **대화가 비어 있을 때만** 선다 — 온보딩 상태 머신이 아니라 메시지
 * 수의 함수다. 첫 마디가 생기면 사라지고, 그 뒤로는 보통의 세션 화면이다.
 *
 * 우측 증거 패널은 없다. 이 세션에는 프로젝트가 없어서 볼 깃도 파일도 없다 —
 * 빈 패널을 띄우면 "여기서 뭘 봐야 하나"를 매번 묻게 된다.
 */
export function OrchestratorView() {
  const id = useStore((s) => s.orchestratorId)
  // 기록을 아직 안 불러왔으면 "비었다"고 단정하지 않는다 — 카드가 번쩍였다 사라진다
  const chatEmpty = useStore((s) => (id ? s.chat[id] !== undefined && s.chat[id].length === 0 : false))
  const mcpProposals = useStore((s) => s.mcpProposals)
  const resolveMcpProposal = useStore((s) => s.resolveMcpProposal)

  if (!id) return <OrchestratorEmpty />
  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/*
        MCP 서버 제안 카드 (propose_mcp_server → b안: 사람의 원클릭 승인). 대화 위에
        배너로 선다 — 오케스트레이터가 제안한 그 대화 문맥 옆에서 결정해야 하기
        때문이다. 승인은 곧 임의 명령 실행의 등록이라 명령 전문을 그대로 보여준다.
      */}
      {mcpProposals.map((p) => (
        <div
          key={p.name}
          className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-2.5"
          data-testid={`mcp-proposal-${p.name}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-chalk">
              Orchestrator asks to install MCP server <span className="readout">{p.name}</span>
              {p.why && <span className="text-ash"> — {p.why}</span>}
            </p>
            <p className="readout mt-0.5 truncate text-[10px] text-slate">
              {p.command} {p.args.join(' ')}
            </p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded border border-ash/50 bg-graphite px-2.5 py-1 text-[11px] text-chalk transition-colors hover:border-ash"
            onClick={() => void resolveMcpProposal(p.name, true)}
            data-testid={`mcp-approve-${p.name}`}
          >
            Install & restart
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 text-[11px] text-slate transition-colors hover:text-chalk"
            onClick={() => void resolveMcpProposal(p.name, false)}
            data-testid={`mcp-dismiss-${p.name}`}
          >
            Dismiss
          </button>
        </div>
      ))}
      <SessionPane sessionId={id} />
      {/*
        세션은 있는데 대화가 빈 경우(만들어만 두고 말을 안 걸었거나, 보내기가 실패한
        경우)에도 같은 카드가 선다 — 카드는 메시지 수의 함수라는 규칙의 나머지 절반.
        덮개로 띄우는 이유: SessionPane의 입력창·설정 메뉴는 그대로 살아 있어야 한다.
      */}
      {chatEmpty && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 top-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <Suggestions ask={(t) => void useStore.getState().send(id, t)} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 추천 질문 (#63) — **읽는 답이 아니라 행동으로 끝나는 질문들**.
 *
 * "이 앱은 뭐 하는 앱인가요?"는 없다: 다운로드한 사람은 이미 대충 안다 (사용자 지적).
 * 대신 행동 하나(프로젝트 생성 — propose_project 카드로 끝난다) · 이 창구의 능력
 * 하나 · 이 앱을 고른 이유(다중 세션) 하나. **클릭은 곧 전송이다** — 입력창을
 * 채워주는 중간 단계가 없다. 그 클릭이 오케스트레이터를 깨우는 지연 기동 트리거다.
 */
const QUESTIONS = [
  { key: 'create-project', text: 'Create a project for me.' },
  { key: 'capabilities', text: 'What can you do as the orchestrator?' },
  { key: 'multi-session', text: 'How do I run and watch several sessions at once?' },
] as const

function Suggestions({ ask }: { ask: (text: string) => void }) {
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const openNewSession = useStore((s) => s.openNewSession)
  const setToast = useStore((s) => s.setToast)
  const waking = useStore((s) => s.orchestratorWaking)
  const [picking, setPicking] = useState(false)

  return (
    <div className="w-full max-w-md px-6" data-testid="orchestrator-suggestions">
      <p className="text-[13px] text-ash">
        This is your <span className="text-chalk">orchestrator</span>. Ask it anything about this
        app or your sessions — try one:
      </p>
      <div className="mt-3 space-y-2">
        {QUESTIONS.map((q) => (
          <button
            key={q.key}
            data-testid={`suggest-${q.key}`}
            disabled={waking}
            onClick={() => ask(q.text)}
            className="block w-full rounded-lg border border-edge bg-panel px-4 py-3 text-left text-[13px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
          >
            {q.text}
          </button>
        ))}
      </div>
      {waking && (
        <p className="mt-2 text-[11px] text-slate" data-testid="orchestrator-waking">
          Starting the orchestrator…
        </p>
      )}
      {/*
        말 걸기 싫은 사람의 길 — 대화를 강요하지 않는다 (#63 탈출구).
        FirstRun이 하던 그대로: 피커 → 프로젝트 → 세션 만들기 창까지 이어준다.
      */}
      <button
        className="mt-3 text-[12px] text-slate underline-offset-2 hover:text-chalk hover:underline disabled:opacity-40"
        data-testid="orchestrator-pick-folder"
        disabled={picking}
        onClick={async () => {
          setPicking(true)
          try {
            const picked = await platform.system.pickDirectory()
            if (picked) openNewSession((await addProject(picked)).id)
          } catch (e) {
            setToast((e as Error).message)
          } finally {
            setPicking(false)
          }
        }}
      >
        …or just pick a folder to start a session
      </button>
    </div>
  )
}

/**
 * 아직 태어나지 않은 오케스트레이터의 자리. SessionPane은 세션 id 없이는 설 수
 * 없으므로, 같은 골격(가운데 내용 + 아래 입력창)을 가볍게 흉내 낸다 — 첫 마디가
 * 들어오는 순간 진짜 SessionPane이 이 자리를 물려받는다.
 */
function OrchestratorEmpty() {
  const askOrchestrator = useStore((s) => s.askOrchestrator)
  const waking = useStore((s) => s.orchestratorWaking)
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t || waking) return
    setText('')
    void askOrchestrator(t)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="orchestrator-empty">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Suggestions ask={(t) => void askOrchestrator(t)} />
      </div>
      {/* 진짜 입력창과 같은 옷 — 다음 순간 SessionPane의 입력창이 이 자리에 선다 */}
      <div className="shrink-0 px-4 pb-4">
        <textarea
          rows={1}
          value={text}
          disabled={waking}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask the orchestrator anything…"
          className="w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2.5 text-[13px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none disabled:opacity-40"
          data-testid="orchestrator-input"
        />
      </div>
    </div>
  )
}
