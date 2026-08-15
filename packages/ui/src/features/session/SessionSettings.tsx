import type { PermissionPreset, ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'

/**
 * 세션 헤더의 모델·권한 셀렉터 (FR-7).
 * 대화를 시작한 뒤에도 바꿀 수 있다 — 시작 전에 정하는 것보다 이쪽이 실제로 쓸모 있다.
 * 변경은 다음 턴부터 적용된다.
 */

/** 도구별 모델 후보. 목록에 없는 값도 세션에 남아 있으면 그대로 보여준다 */
const MODELS: Record<ToolName, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: '기본' },
    { value: 'haiku', label: 'Haiku · 빠름' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus · 깊게' },
  ],
  codex: [
    { value: '', label: '기본' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-terra-mini', label: 'gpt-5.6-terra-mini' },
  ],
}

const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: '안전', hint: '모든 작업을 묻습니다' },
  { value: 'normal', label: '일반', hint: '위험한 작업만 묻습니다' },
  { value: 'auto', label: '자동', hint: '묻지 않습니다 — 승인 화면이 뜨지 않습니다' },
]

export function SessionSettings({
  sessionId,
  tool,
  model,
  preset,
}: {
  sessionId: string
  tool: ToolName
  model: string | null
  preset: PermissionPreset
}) {
  const update = useStore((s) => s.updateSessionSettings)
  const options = MODELS[tool] ?? MODELS.claude
  // 목록에 없는 모델(직접 설정한 값)도 유실되지 않게 임시 항목으로 넣는다
  const known = options.some((o) => o.value === (model ?? ''))
  const all = known ? options : [...options, { value: model!, label: model! }]

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <select
        className="cursor-pointer rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:text-chalk focus:border-graphite focus:outline-none"
        value={model ?? ''}
        onChange={(e) => void update(sessionId, { model: e.target.value || null })}
        data-testid="model-select"
        title="모델 — 다음 턴부터 적용됩니다"
      >
        {all.map((o) => (
          <option key={o.value} value={o.value} className="bg-panel">
            {o.label}
          </option>
        ))}
      </select>

      <select
        className="cursor-pointer rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:text-chalk focus:border-graphite focus:outline-none"
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
