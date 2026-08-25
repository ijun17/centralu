import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from '../../components/Modal.jsx'
import { ChevronIcon } from '../../components/icons.jsx'
import type { ModelOption, PermissionPreset, ToolName } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * 입력창 아래 설정 메뉴 — 모델·추론 강도·권한·에이전트 (FR-7).
 * 대화를 시작한 뒤에도 바꿀 수 있다 — 시작 전에 정하는 것보다 이쪽이 실제로 쓸모 있다.
 *
 * **셀렉터 네 개를 나란히 세우지 않는다.** 예전엔 `<select>`가 줄지어 서 있었는데,
 * 넷 다 평소엔 볼 일이 없는 것들이라 입력창 아래 한 줄을 늘 차지하기만 했고,
 * 그리드처럼 폭이 좁은 칸에서는 넷이 서로를 밀어내 글자가 잘렸다.
 * 지금 값은 버튼 한 줄로 읽히고, 바꿀 때만 메뉴가 열린다 (Claude Code와 같은 방식).
 *
 * **모델 목록을 우리가 적지 않는다.** 도구의 공식 API가 알려주는 것을 그대로 보여준다
 * (Claude `supportedModels()` · Codex `model/list`).
 * 예전엔 여기에 하드코딩했는데, 그래서 Fable이 나왔을 때 고를 방법이 없었다 —
 * 도구가 올라가는데 이 앱만 제자리인 그 상황을 다시 만들지 않는다.
 */

const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: 'Safe', hint: 'Asks for everything' },
  { value: 'normal', label: 'Normal', hint: 'Asks only for risky actions' },
  { value: 'auto', label: 'Auto', hint: 'Never asks' },
]

/**
 * 도구별 모델 목록. 셀렉터를 열 때마다 도구를 띄우면 그 클릭이 느려지므로
 * host가 캐시하고, 여기서는 도구가 바뀔 때만 한 번 묻는다.
 */
export function useModels(tool: ToolName, live: boolean): { models: ModelOption[]; reason?: string } {
  const platform = usePlatform()
  const [state, setState] = useState<{ models: ModelOption[]; reason?: string }>({ models: [] })

  /*
   * `live`가 의존성에 있는 이유:
   *
   * Claude SDK는 모델 목록을 Query에만 둔다. 그래서 **실행 중인 세션이 없으면 못 읽는다**.
   * 앱을 켜고 잠든 세션을 고르면 그 순간엔 질의가 없어서 목록이 비고, 한 번 비면
   * 다시 묻지 않아 셀렉터에 "기본"만 남았다 (도그푸딩 지적).
   * 세션이 깨어나는 순간 다시 묻는다.
   */
  useEffect(() => {
    let alive = true
    void platform.agents
      .models(tool)
      .then((r) => alive && setState({ models: r.models, reason: r.supported ? undefined : r.reason }))
      // 목록을 못 읽어도 세션은 계속 쓸 수 있어야 한다 — 이유만 남기고 기본값으로 돈다
      .catch((e: Error) => alive && setState({ models: [], reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, tool, live])

  return state
}

const TOOL_LABEL: Record<ToolName, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * 이 도구의 응답 길이 단계 (#54). 비어 있으면 그 도구에는 노브가 없어서 행 자체가 안 뜬다.
 *
 * 도구 이름으로 갈리지 않는다 — 어댑터 능력 선언(verbosities)을 읽는다.
 * codex에만 있는 노브지만 "codex면 보여줘"라고 적는 순간, Claude가 같은 노브를
 * 얻는 날 이 파일을 아는 사람만 고칠 수 있는 코드가 된다.
 */
export function useVerbosities(tool: ToolName): string[] {
  const platform = usePlatform()
  const [levels, setLevels] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void platform.agents
      .capabilities(tool)
      .then((c) => alive && setLevels(c.verbosities))
      // 능력을 못 읽어도 메뉴는 떠야 한다 — 행 하나가 빠질 뿐이다
      .catch(() => alive && setLevels([]))
    return () => {
      alive = false
    }
  }, [platform, tool])
  return levels
}

/**
 * 메뉴 한 줄.
 *
 * 고른 것은 **왼쪽 한 칸**에만 표식을 넣어 말한다. 오른쪽에 붙이면 줄마다 표식의
 * 가로 위치가 달라져서, 무엇이 골라져 있는지 눈이 목록을 훑어야 알 수 있다.
 * 빈 칸을 늘 남겨두면 표식이 있든 없든 글자의 시작이 한 줄로 선다.
 */
function MenuRow({
  label,
  hint,
  selected,
  onPick,
  testId,
  title,
}: {
  label: string
  hint?: string
  selected: boolean
  onPick: () => void
  testId: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      title={title}
      onClick={onPick}
      className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors ${
        selected ? 'text-chalk' : 'text-ash hover:bg-graphite/25'
      }`}
    >
      <span className="w-2 shrink-0 text-[10px] leading-none text-ash" aria-hidden>
        {selected ? '✓' : ''}
      </span>
      <span className="min-w-0 truncate text-[12px]">{label}</span>
      {hint && <span className="readout ml-auto shrink-0 truncate text-[10px] text-slate">{hint}</span>}
    </button>
  )
}

function MenuSection({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="border-t border-edge py-1 first:border-t-0">
      <p className="readout px-2.5 py-0.5 text-[10px] uppercase tracking-wide text-slate">{label}</p>
      {/* 왜 이 묶음이 다른지는 묶음 머리에 적는다 — 줄마다 반복하면 목록이 안 읽힌다 */}
      {note && <p className="px-2.5 pb-1 text-[10px] leading-relaxed text-slate">{note}</p>}
      {children}
    </div>
  )
}

export function SessionSettings({
  sessionId,
  tool,
  model,
  effort,
  verbosity,
  preset,
  live,
}: {
  sessionId: string
  tool: ToolName
  model: string | null
  effort: string | null
  /** 응답 길이 (#54). null이면 도구 기본값 */
  verbosity: string | null
  preset: PermissionPreset
  /** 프로세스가 살아 있는가 — Claude는 살아 있어야 모델 목록을 준다 */
  live: boolean
}) {
  const update = useStore((s) => s.updateSessionSettings)
  const switchTool = useStore((s) => s.switchTool)
  const { models, reason } = useModels(tool, live)
  const verbosities = useVerbosities(tool)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<ToolName | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  const current = models.find((m) => m.id === model)
  // 목록에 없는 모델(직접 설정했거나 목록을 못 읽은 경우)도 유실되지 않게 남긴다
  const options = model && !current ? [...models, { id: model, label: model, efforts: [], defaultEffort: null }] : models

  /*
   * 바깥을 누르거나 Esc를 누르면 닫는다.
   *
   * 메뉴는 `<select>`와 달리 브라우저가 닫아주지 않는다. 한 번 열리면 남아 있는
   * 메뉴는 입력창을 가리는 벽이 되므로, 닫는 길을 여기서 한 번에 챙긴다.
   * (확인 창이 뜰 때는 먼저 닫으므로 Esc를 두 곳이 함께 먹는 일은 없다.)
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 인박스·모달까지 같이 닫히면 안 된다 — 열려 있는 것 중 가장 안쪽만 닫는다
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const choose = (patch: Parameters<typeof update>[1]) => {
    void update(sessionId, patch)
    // 고르면 닫는다 — 하나 고르러 열었는데 계속 열려 있으면 입력창을 다시 눌러야 한다
    setOpen(false)
  }

  const modelLabel = current?.label ?? model ?? 'Default'
  // 지금 값은 열지 않아도 읽혀야 한다 — 메뉴로 감춘 대가를 여기서 갚는다.
  // verbosity는 effort와 단계 이름이 겹쳐서(low/medium/high) 맨몸으로 놓으면 어느 쪽인지 알 수 없다 — 이름을 붙인다
  const summary = [modelLabel, effort, verbosity && `${verbosity} verbosity`, PRESETS.find((p) => p.value === preset)?.label]
    .filter(Boolean)
    .join(' · ')

  return (
    <span className="relative flex min-w-0 items-center" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="settings-open"
        title={
          reason
            ? `Could not load models: ${reason}`
            : 'Model, effort, permissions — applies from the next turn'
        }
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:text-chalk"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronIcon open={open} size={10} />
      </button>

      {open && (
        /*
          위로 편다. 이 줄은 창(또는 그리드 칸)의 맨 아래라 아래로 펴면 곧바로 잘린다 —
          자동완성 메뉴가 같은 이유로 같은 방향을 쓴다.
        */
        <div
          role="menu"
          data-testid="settings-menu"
          className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-56 overflow-y-auto overflow-x-hidden rounded border border-edge bg-panel shadow-[0_-12px_32px_-8px_rgb(0_0_0/0.9)]"
        >
          <MenuSection label="Model">
            {/*
              도구가 자기 '기본' 항목을 주면(Claude의 `default`) 우리 것을 또 넣지 않는다 —
              같은 뜻의 줄이 둘이면 어느 쪽을 골라야 하는지 알 수 없다.
            */}
            {!models.some((m) => m.id === 'default') && (
              <MenuRow
                testId="settings-model-default"
                label="Default"
                selected={!model}
                onPick={() => choose({ model: null, effort: null })}
              />
            )}
            {options.map((m) => (
              <MenuRow
                key={m.id}
                testId={`settings-model-${m.id}`}
                label={m.label}
                title={m.description}
                selected={m.id === model}
                // 모델이 바뀌면 강도는 초기화한다 — 모델마다 단계가 달라서
                // 옛 값을 들고 가면 지원하지 않는 조합이 조용히 남는다
                onPick={() => choose({ model: m.id, effort: null })}
              />
            ))}
          </MenuSection>

          {/* 강도는 지원하는 모델에서만 보인다 — 아무 효과 없는 항목을 띄우면 거짓말이 된다 */}
          {current && current.efforts.length > 0 && (
            <MenuSection label="Effort">
              <MenuRow
                testId="settings-effort-default"
                label="Default"
                selected={!effort}
                onPick={() => choose({ effort: null })}
              />
              {current.efforts.map((lv) => (
                <MenuRow
                  key={lv}
                  testId={`settings-effort-${lv}`}
                  label={lv}
                  selected={lv === effort}
                  onPick={() => choose({ effort: lv })}
                />
              ))}
            </MenuSection>
          )}

          {/* 응답 길이 (#54) — 도구가 이 노브를 줄 때만 보인다. 실측: low 82단어 · high 269단어 (같은 질문) */}
          {verbosities.length > 0 && (
            <MenuSection label="Verbosity" note="How long answers run — shorter arrives sooner.">
              <MenuRow
                testId="settings-verbosity-default"
                label="Default"
                selected={!verbosity}
                onPick={() => choose({ verbosity: null })}
              />
              {verbosities.map((lv) => (
                <MenuRow
                  key={lv}
                  testId={`settings-verbosity-${lv}`}
                  label={lv}
                  selected={lv === verbosity}
                  onPick={() => choose({ verbosity: lv })}
                />
              ))}
            </MenuSection>
          )}

          <MenuSection label="Permissions">
            {PRESETS.map((p) => (
              <MenuRow
                key={p.value}
                testId={`settings-preset-${p.value}`}
                label={p.label}
                hint={p.hint}
                selected={p.value === preset}
                onPick={() => choose({ permissionPreset: p.value })}
              />
            ))}
          </MenuSection>

          {/*
            에이전트는 **되돌릴 수 없는 것**이라 맨 아래에 따로 세운다.
            위의 셋은 같은 대화를 이어가며 바뀌지만 이쪽은 대화가 끊긴다
            (externalId가 도구 고유 id라 새 도구가 이어받을 수 없다).
            같은 메뉴에 있다고 같은 무게로 다루면 사람이 그 차이를 모른 채 누른다 —
            그래서 무슨 일이 일어나는지 먼저 적고, 눌러도 곧바로 바뀌지 않는다.
          */}
          <MenuSection label="Agent" note="Switching starts a fresh conversation.">
            {(Object.keys(TOOL_LABEL) as ToolName[]).map((t) => (
              <MenuRow
                key={t}
                testId={`settings-tool-${t}`}
                label={TOOL_LABEL[t]}
                selected={t === tool}
                title={t === tool ? undefined : `${TOOL_LABEL[t]} will not have this conversation`}
                onPick={() => {
                  setOpen(false)
                  if (t !== tool) setAsking(t)
                }}
              />
            ))}
          </MenuSection>
        </div>
      )}

      {asking && asking !== tool && (
        <Modal onClose={() => setAsking(null)} testId="tool-switch-confirm">
          <h2 className="text-[13px] font-medium text-chalk">Switch to {TOOL_LABEL[asking]}?</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-ash">
            {TOOL_LABEL[asking]} <b className="text-chalk">will not have this conversation.</b> Each tool keeps
            its own memory, so the new agent starts fresh.
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate">
            Your transcript stays here, and the {TOOL_LABEL[tool]} conversation is still available
            under <span className="text-ash">+ → past conversations</span>.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk"
              onClick={() => setAsking(null)}
              data-testid="tool-switch-cancel"
            >
              Cancel
            </button>
            <button
              className="rounded border border-graphite px-2.5 py-1 text-[12px] text-chalk hover:bg-graphite/50"
              onClick={() => {
                void switchTool(sessionId, asking)
                setAsking(null)
              }}
              data-testid="tool-switch-confirm-btn"
            >
              Switch
            </button>
          </div>
        </Modal>
      )}
    </span>
  )
}
