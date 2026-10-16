import { useState } from 'react'
import type { AgentDifficulty, AgentModelChoice, AgentModels, ToolStatus } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useTools } from '../../store/selectors.js'
import { isPlainEnter } from '../../app/keys.js'
import { useModels } from '../session/SessionSettings.jsx'

const LEVELS: { id: AgentDifficulty; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'standard', label: 'Standard' },
  { id: 'heavy', label: 'Heavy' },
]

const OTHER = '\u0000other'

/** The same look as the other controls of this block (the running-agents field) and Background's select */
const SELECT = 'rounded-md border border-line bg-surface-floor px-1.5 py-0.5 text-sm text-ink'

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
    <div className="mt-4" data-testid="settings-agent-models">
      <p className="text-sm text-ink-muted">Models for the agents a session starts</p>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        A session starting an agent can say how hard the job is instead of naming a model. Light: lookups, small fixes,
        reviews of small changes. Heavy: design, security, risk of losing data, large refactors. Default keeps the
        project&apos;s last choice; a model the session names itself still wins.
      </p>
      {tools.map((t) => (
        <ToolRows key={t.name} tool={t} chosen={models?.[t.name]} onPick={(level, choice) => pick(t.name, level, choice)} />
      ))}
    </div>
  )
}

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
    <div className="mt-3" data-testid={`settings-agent-models-${tool.name}`}>
      <p className="readout text-2xs uppercase text-ink-faint">{tool.label}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm text-ink-muted">
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
      </div>
    </div>
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
  const [other, setOther] = useState(false)
  const [draft, setDraft] = useState('')
  // A model chosen before and no longer listed (or typed, or a list not read yet) stays shown as itself
  const options = value && !models.some((m) => m.id === value.model) ? [...models, { id: value.model, label: value.model, efforts: [] }] : models
  const efforts = options.find((m) => m.id === value?.model)?.efforts ?? []
  const effortOptions = value?.effort && !efforts.includes(value.effort) ? [...efforts, value.effort] : efforts
  const commit = () => {
    const model = draft.trim()
    if (!model) return
    setOther(false)
    if (model !== value?.model) onPick({ model })
  }
  return (
    <>
      <span>{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT}
          aria-label={`${label} model`}
          data-testid={testId}
          value={other ? OTHER : (value?.model ?? '')}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setOther(true)
              setDraft(listed ? '' : (value?.model ?? ''))
              return
            }
            setOther(false)
            // A new model takes its own default effort: the effort chosen belonged to the old one
            onPick(e.target.value ? { model: e.target.value } : null)
          }}
        >
          <option value="">Default</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {other && (
          <input
            type="text"
            value={draft}
            spellCheck={false}
            autoFocus
            placeholder="Model name"
            aria-label={`${label} model name`}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // A Korean name's last syllable is still being composed on that Enter (#181)
              if (isPlainEnter(e.nativeEvent)) commit()
            }}
            className="w-40 rounded border border-line bg-surface-floor px-2 py-1 text-sm text-ink placeholder:text-ink-faint"
            data-testid={`${testId}-other`}
          />
        )}
        {value && !other && effortOptions.length > 0 && (
          <select
            className={SELECT}
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
          </select>
        )}
      </div>
    </>
  )
}
