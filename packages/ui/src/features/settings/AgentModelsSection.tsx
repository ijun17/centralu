import type { AgentDifficulty, AgentModelChoice, AgentModels, ToolStatus } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { useTools } from '../../store/selectors.js'
import { useModels } from '../session/SessionSettings.jsx'
import { OtherInput, OtherOption, SettingsSelect, useOtherChoice } from './OtherChoice.jsx'
import { textInputClass } from '../../components/TextField.jsx'
import { More, SettingsCard } from './SettingsLayout.jsx'

const LEVELS: { id: AgentDifficulty; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'standard', label: 'Standard' },
  { id: 'heavy', label: 'Heavy' },
]

/**
 * Background's select, at one width per column: Claude's and Codex's rows line up, and a row does not move when the
 * model list arrives after the first paint
 */
const MODEL_WIDTH = 'w-40'
const EFFORT_WIDTH = 'w-32'

/**
 * Which model a session's start_agent runs per tool and difficulty (#729). A calling agent says how hard the job is
 * (light, standard, heavy) instead of naming a model, and the person's choice here applies. It sits under "Running
 * agents per project" because it answers the same errand: how the agents a session starts behave.
 *
 * One select per difficulty and tool, the Background category's control, with "Other…" for a model the list does not
 * show, the font picker's pattern: Claude lists its models only while a session runs, so the list may be empty here.
 * The effort select appears once a model is chosen, as in the session menu: an effort belongs to its model.
 */
export function AgentModelsSection() {
  const tools = useTools()
  const models = useStore((s) => s.prefs.agentModels)
  const setPrefs = useStore((s) => s.setPrefs)
  if (tools.length === 0) return null
  const pick = (tool: string, level: AgentDifficulty, choice: AgentModelChoice | null) => {
    const own = { ...models?.[tool] }
    if (choice) own[level] = choice
    else delete own[level]
    const next: AgentModels = { ...models, [tool]: own }
    void setPrefs({ agentModels: next })
  }
  return (
    <div className="space-y-3" data-testid="settings-agent-models">
      <div className="px-1">
        <h4 className="text-xs font-medium text-ink-muted">Models for the agents a session starts</h4>
        <div className="mt-0.5 text-xs leading-body text-ink-faint">
          A session starting an agent can say how hard the job is instead of naming a model.
          <More>
            Light: lookups, small fixes, reviews of small changes. Heavy: design, security, risk of losing data, large
            refactors. Default keeps the project&apos;s last choice; a model the session names itself still wins. Efforts
            come from the tool&apos;s model list, which Claude Code gives only while one of its sessions runs.
          </More>
        </div>
      </div>
      {tools.map((t) => (
        <ToolRows key={t.name} tool={t} chosen={models?.[t.name]} onPick={(level, choice) => pick(t.name, level, choice)} />
      ))}
    </div>
  )
}

/** A card per tool: its name over three rows, Light, Standard and Heavy, whose selects line up in two columns */
function ToolRows({
  tool,
  chosen,
  onPick,
}: {
  tool: ToolStatus
  chosen: AgentModels[string] | undefined
  onPick: (level: AgentDifficulty, choice: AgentModelChoice | null) => void
}) {
  const { models } = useModels(tool.name, false)
  return (
    <SettingsCard testId={`settings-agent-models-${tool.name}`}>
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{tool.label}</span>
        <span className={`${MODEL_WIDTH} text-2xs text-ink-faint`}>Model</span>
        <span className={`${EFFORT_WIDTH} text-2xs text-ink-faint`}>Effort</span>
      </div>
      {LEVELS.map((l) => (
        <LevelRow
          key={l.id}
          testId={`settings-agent-model-${tool.name}-${l.id}`}
          label={l.label}
          models={models}
          value={chosen?.[l.id]}
          onPick={(choice) => onPick(l.id, choice)}
        />
      ))}
    </SettingsCard>
  )
}

function LevelRow({
  testId,
  label,
  models,
  value,
  onPick,
}: {
  testId: string
  label: string
  models: { id: string; label: string; efforts: string[] }[]
  value: AgentModelChoice | undefined
  onPick: (choice: AgentModelChoice | null) => void
}) {
  const listed = !value || models.some((m) => m.id === value.model)
  const choice = useOtherChoice({ other: false, draft: '' })
  const { other } = choice
  // A model chosen before and no longer listed (or typed, or a list not read yet) stays shown as itself
  const options = value && !models.some((m) => m.id === value.model) ? [...models, { id: value.model, label: value.model, efforts: [] }] : models
  // A model the list does not show (typed under Other…) is offered every effort the tool's listed models have
  const efforts = models.find((m) => m.id === value?.model)?.efforts ?? [...new Set(models.flatMap((m) => m.efforts))]
  const effortOptions = value?.effort && !efforts.includes(value.effort) ? [...efforts, value.effort] : efforts
  const commit = () => {
    const model = choice.draft.trim()
    // Left empty: back to the select as it was, rather than a field nothing will fill
    choice.close()
    if (!model) return
    if (model !== value?.model) onPick({ model })
  }
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{label}</span>
      <SettingsSelect
        tone="compact"
        className={MODEL_WIDTH}
        aria-label={`${label} model`}
        data-testid={testId}
        value={choice.shown(value?.model ?? '')}
        onChange={(e) =>
          choice.onSelect(e, listed ? '' : (value?.model ?? ''), (model) =>
            // A new model takes its own default effort: the effort chosen belonged to the old one
            onPick(model ? { model } : null),
          )
        }
      >
        <option value="">Default</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <OtherOption />
      </SettingsSelect>
      {/* The second column holds its width when empty, so the model selects of every row stay in line */}
      <span className={`${EFFORT_WIDTH} flex`}>
        {other && (
          <OtherInput
            draft={choice.draft}
            onDraft={choice.setDraft}
            commit={commit}
            autoFocus={choice.asked}
            placeholder="Model name"
            aria-label={`${label} model name`}
            className={`w-full ${textInputClass({ size: 'sm', text: 'sm' })}`}
            data-testid={`${testId}-other`}
          />
        )}
        {value && !other && effortOptions.length > 0 && (
          <SettingsSelect
            tone="compact"
            className="w-full"
            aria-label={`${label} effort`}
            data-testid={`${testId}-effort`}
            value={value.effort ?? ''}
            onChange={(e) => onPick({ model: value.model, ...(e.target.value ? { effort: e.target.value } : {}) })}
          >
            <option value="">Default effort</option>
            {effortOptions.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </SettingsSelect>
        )}
      </span>
    </div>
  )
}
