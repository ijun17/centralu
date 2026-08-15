import { useCallback, useEffect, useState } from 'react'
import type { PermissionPreset, ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { Kbd } from '../../components/primitives.jsx'

type Detection = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

/** 프리셋은 도구의 전역 설정을 세션 단위로 덮어쓴다 (M0에서 검증한 전제) */
const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: '안전', hint: '모든 작업을 묻습니다' },
  { value: 'normal', label: '일반', hint: '위험한 작업만 묻습니다' },
  { value: 'auto', label: '자동 승인', hint: '묻지 않습니다 — 승인 화면이 뜨지 않습니다' },
]

/**
 * 세션 생성 (FR-7 완성).
 * 도구 → 모델 → 권한 프리셋 → 시작 프롬프트. 프로젝트별 기본값을 읽고 쓴다.
 * 지금까지는 앱이 프리셋을 'normal'로 고정하고 모델을 아예 전달하지 않았다.
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const setToast = useStore((s) => s.setToast)
  const running = useSessionsOf(projectId).filter((s) => !s.archived)

  const [tools, setTools] = useState<Detection[] | null>(null)
  const [tool, setTool] = useState<ToolName>(project?.defaultTool ?? 'claude')
  const [model, setModel] = useState(project?.defaultModel ?? '')
  const [preset, setPreset] = useState<PermissionPreset>('normal')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

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

  const usable = (t: ToolName) => {
    const d = tools?.find((x) => x.tool === t)
    return !tools || (d?.installed === true && d.loggedIn)
  }

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-void/80 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="new-session-dialog"
    >
      <form
        className="w-[520px] max-w-[92vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await createSession(projectId, {
              tool,
              model: model.trim() || undefined,
              permissionPreset: preset,
              initialPrompt: prompt.trim() || undefined,
            })
            onClose()
          } catch (err) {
            setToast((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">새 세션 · {project?.name}</h2>

        {/* 동시 세션은 데이터 손실 위험 — 차단하지 않고 여기서 보이게 한다 (FR-2) */}
        {running.length > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="concurrent-warning">
            이 디렉토리에서 세션 {running.length}개가 실행 중입니다. 같은 파일을 고치면 변경이 유실될 수 있습니다.
          </p>
        )}

        <Field label="도구">
          <div className="flex gap-1.5">
            {(['claude', 'codex'] as const).map((t) => (
              <button
                key={t}
                type="button"
                disabled={!usable(t)}
                onClick={() => setTool(t)}
                data-testid={`tool-option-${t}`}
                title={tools?.find((x) => x.tool === t)?.detail}
                className={`rounded border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 ${
                  tool === t ? 'border-ash bg-graphite/40 text-chalk' : 'border-edge text-ash hover:text-chalk'
                }`}
              >
                {TOOL_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="모델" hint="비워두면 도구 기본값">
          <input
            className="w-full rounded border border-edge bg-panel px-2.5 py-1.5 font-mono text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            placeholder={tool === 'claude' ? 'haiku · sonnet · opus' : 'gpt-5.x'}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            data-testid="model-input"
            spellCheck={false}
          />
        </Field>

        <Field label="권한">
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPreset(p.value)}
                data-testid={`preset-${p.value}`}
                title={p.hint}
                className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                  preset === p.value ? 'border-ash bg-graphite/40 text-chalk' : 'border-edge text-ash hover:text-chalk'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-slate">{PRESETS.find((p) => p.value === preset)?.hint}</p>
        </Field>

        <Field label="시작 프롬프트" hint="선택">
          <textarea
            className="max-h-32 w-full resize-none rounded border border-edge bg-panel px-2.5 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="무엇을 시킬까요"
            data-testid="initial-prompt"
          />
        </Field>

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>esc</Kbd> 닫기
          </span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            취소
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || !usable(tool)}
            data-testid="create-session-confirm"
          >
            시작
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-3.5">
      <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">
        {label}
        {hint && <span className="ml-1.5 normal-case tracking-normal text-slate/70">{hint}</span>}
      </h3>
      {children}
    </section>
  )
}
