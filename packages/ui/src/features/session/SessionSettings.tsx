import { useEffect, useState } from 'react'
import type { ModelOption, PermissionPreset, ToolName } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * 세션 헤더의 모델·추론 강도·권한 셀렉터 (FR-7).
 * 대화를 시작한 뒤에도 바꿀 수 있다 — 시작 전에 정하는 것보다 이쪽이 실제로 쓸모 있다.
 *
 * **모델 목록을 우리가 적지 않는다.** 도구의 공식 API가 알려주는 것을 그대로 보여준다
 * (Claude `supportedModels()` · Codex `model/list`).
 * 예전엔 여기에 하드코딩했는데, 그래서 Fable이 나왔을 때 고를 방법이 없었다 —
 * 도구가 올라가는데 이 앱만 제자리인 그 상황을 다시 만들지 않는다.
 */

const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: '안전', hint: '모든 작업을 묻습니다' },
  { value: 'normal', label: '일반', hint: '위험한 작업만 묻습니다' },
  { value: 'auto', label: '자동', hint: '묻지 않습니다 — 승인 화면이 뜨지 않습니다' },
]

const SELECT =
  'cursor-pointer rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:text-chalk focus:border-graphite focus:outline-none'

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

export function SessionSettings({
  sessionId,
  tool,
  model,
  effort,
  preset,
  live,
}: {
  sessionId: string
  tool: ToolName
  model: string | null
  effort: string | null
  preset: PermissionPreset
  /** 프로세스가 살아 있는가 — Claude는 살아 있어야 모델 목록을 준다 */
  live: boolean
}) {
  const update = useStore((s) => s.updateSessionSettings)
  const { models, reason } = useModels(tool, live)

  const current = models.find((m) => m.id === model)
  // 목록에 없는 모델(직접 설정했거나 목록을 못 읽은 경우)도 유실되지 않게 남긴다
  const options = model && !current ? [...models, { id: model, label: model, efforts: [], defaultEffort: null }] : models

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <select
        className={SELECT}
        value={model ?? ''}
        onChange={(e) => {
          const next = e.target.value || null
          // 모델이 바뀌면 강도는 초기화한다 — 모델마다 단계가 달라서
          // 옛 값을 들고 가면 지원하지 않는 조합이 조용히 남는다
          void update(sessionId, { model: next, effort: null })
        }}
        data-testid="model-select"
        title={reason ? `모델 목록을 읽지 못했습니다: ${reason}` : '모델 — 다음 턴부터 적용됩니다'}
      >
        {/*
          도구가 자기 '기본' 항목을 주면(Claude의 `default`) 우리 것을 또 넣지 않는다 —
          같은 뜻의 줄이 둘이면 어느 쪽을 골라야 하는지 알 수 없다.
        */}
        {!models.some((m) => m.id === 'default') && (
          <option value="" className="bg-panel">
            기본
          </option>
        )}
        {options.map((m) => (
          <option key={m.id} value={m.id} className="bg-panel" title={m.description}>
            {m.label}
          </option>
        ))}
      </select>

      {/* 강도는 지원하는 모델에서만 보인다 — 아무 효과 없는 셀렉터를 띄우면 거짓말이 된다 */}
      {current && current.efforts.length > 0 && (
        <select
          className={SELECT}
          value={effort ?? ''}
          onChange={(e) => void update(sessionId, { effort: e.target.value || null })}
          data-testid="effort-select"
          title="추론 강도 — 높을수록 더 깊게 생각하고 더 많이 씁니다"
        >
          <option value="" className="bg-panel">
            강도 · 기본
          </option>
          {current.efforts.map((lv) => (
            <option key={lv} value={lv} className="bg-panel">
              강도 · {lv}
            </option>
          ))}
        </select>
      )}

      <select
        className={SELECT}
        value={preset}
        onChange={(e) => void update(sessionId, { permissionPreset: e.target.value as PermissionPreset })}
        data-testid="preset-select"
        title={PRESETS.find((p) => p.value === preset)?.hint}
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value} className="bg-panel">
            권한 · {p.label}
          </option>
        ))}
      </select>
    </span>
  )
}
