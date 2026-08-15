import { useCallback, useEffect, useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { Kbd } from '../../components/primitives.jsx'

type Detection = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * 세션 생성 (FR-7).
 *
 * **여기서 고르는 것은 도구뿐이다.** 모델·권한은 세션을 만든 뒤 헤더에서 바꾼다 —
 * 시작하기 전에 정할 수 있는 것보다, 대화하며 바꿀 수 있는 것이 실제로 더 유용하다.
 * (도구만 예외인 이유: 도구는 프로세스 자체라 도중에 못 바꾼다)
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const running = useSessionsOf(projectId).filter((s) => !s.archived)

  const [tools, setTools] = useState<Detection[] | null>(null)
  const [tool, setTool] = useState<ToolName>(project?.defaultTool ?? 'claude')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 다이얼로그를 열 때마다 감지한다 — 사용자가 방금 설치·로그인했을 수 있다
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

  const info = (t: ToolName) => tools?.find((x) => x.tool === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-void/80 pt-[14vh] backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="new-session-dialog"
    >
      <form
        className="w-[480px] max-w-[92vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await createSession(projectId, { tool, initialPrompt: prompt.trim() || undefined })
            onClose()
          } catch (err) {
            // 토스트는 2.5초 뒤 사라져서 '눌러도 아무 일이 없다'로 보인다 — 모달 안에 남긴다
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">새 세션 · {project?.name}</h2>

        {running.length > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="concurrent-warning">
            이 디렉토리에서 세션 {running.length}개가 실행 중입니다. 같은 파일을 고치면 변경이 유실될 수 있습니다.
          </p>
        )}

        <section className="mt-3.5">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">도구</h3>
          <div className="flex gap-1.5">
            {(['claude', 'codex'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTool(t)}
                data-testid={`tool-option-${t}`}
                title={info(t)?.detail}
                className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                  tool === t ? 'border-ash bg-graphite/40 text-chalk' : 'border-edge text-ash hover:text-chalk'
                } ${tools && !usable(t) ? 'opacity-50' : ''}`}
              >
                {TOOL_LABEL[t]}
              </button>
            ))}
          </div>
          {/* 못 쓰는 이유를 숨기지 않는다 — 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 */}
          {blocked && (
            <p className="mt-1.5 text-[11px] text-ash" data-testid="tool-blocked">
              {info(tool)?.installed
                ? `${TOOL_LABEL[tool]}에 로그인이 필요합니다 — 터미널에서 ${tool === 'claude' ? 'claude' : 'codex login'} 실행`
                : `${TOOL_LABEL[tool]}를 찾을 수 없습니다 (${info(tool)?.detail ?? '미설치'})`}
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-slate">모델과 권한은 세션을 만든 뒤 헤더에서 바꿉니다.</p>
        </section>

        <section className="mt-3.5">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">
            시작 프롬프트 <span className="normal-case tracking-normal text-slate/70">선택</span>
          </h3>
          <textarea
            autoFocus
            className="max-h-32 w-full resize-none rounded border border-edge bg-panel px-2.5 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
            }}
            placeholder="무엇을 시킬까요"
            data-testid="initial-prompt"
          />
        </section>

        {error && (
          <p className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk" data-testid="create-session-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>esc</Kbd> 닫기 · <Kbd>⌘</Kbd> <Kbd>↵</Kbd> 시작
          </span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            취소
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || blocked}
            data-testid="create-session-confirm"
          >
            {busy ? '시작하는 중…' : '시작'}
          </button>
        </div>
      </form>
    </div>
  )
}
