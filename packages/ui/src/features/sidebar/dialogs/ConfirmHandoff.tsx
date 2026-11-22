import { useState } from 'react'
import type { ToolName } from '@cc/protocol/client'
import { useToolMeta, useTools } from '../../../store/selectors.js'
import { Modal } from '../../../components/Modal.jsx'
import { Badge } from '../../../components/Badge.jsx'
import { Button } from '../../../components/Button.jsx'
import { Segmented } from '../../../components/Segmented.jsx'

/**
 * The handoff dialog: one button for note → new session → archive, said in sentences. Archiving can be undone, so the
 * ordinary palette (#1477), and no typing of the name. The note is plain text, so any tool can receive it.
 */
export function ConfirmHandoff({
  name,
  tool,
  dead,
  blocked,
  backgroundTasks,
  working,
  onConfirm,
  onCancel,
}: {
  name: string
  tool: ToolName
  /** It cannot respond (an error or a rate limit, #78): the receiving tool defaults to the other one */
  dead: boolean
  /** A card is up (#174), so the agent cannot be asked; the record mode does not ask */
  blocked: 'question' | 'approval' | null
  /** Background tasks running now (#290, ambient left out): each one's end wakes a kept original (#1477) */
  backgroundTasks: number
  /** A turn runs: the note holds what is stored so far, and archiving ends the turn (#1477) */
  working: boolean
  onConfirm: (tool: ToolName, deleteOld: boolean, mode: 'agent' | 'record') => void
  onCancel: () => void
}) {
  /*
   * Defaults. The note from the record (#694): the replaced session is least likely to summarize well, and its note can
   * carry drift or injected text. Archive on (#1477): a kept original still runs, a background task's end wakes it for a
   * turn that rewrites its expired cache, its apps stay attached (#1638), and two sessions claim one piece of work. A
   * dead session hands to the other tool (#78). Only initial values: one choice never silently changes another.
   */
  const tools = useTools()
  const otherTool = tools.find((t) => t.name !== tool)?.name ?? tool
  const [mode, setMode] = useState<'agent' | 'record'>('record')
  const [heirTool, setHeirTool] = useState<ToolName>(dead ? otherTool : tool)
  const [deleteOld, setDeleteOld] = useState(true)
  const toolLabel = useToolMeta(tool).label
  return (
    <Modal onClose={onCancel} testId="confirm-handoff">
      <div className="w-[400px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)">
        <p className="text-md text-ink">Hand off to a fresh session?</p>
        <p className="mt-1.5 truncate text-sm text-ink-muted">{name}</p>

        {/* Where the note comes from (#694) */}
        <Badge as="p" className="mt-3">
          Handoff note
        </Badge>
        <Segmented
          label="Handoff note source"
          value={mode}
          onChange={setMode}
          className="mt-1"
          options={[
            { value: 'agent', label: 'Ask the agent', testId: 'handoff-mode-agent' },
            { value: 'record', label: 'From the record', testId: 'handoff-mode-record' },
          ]}
        />
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="handoff-mode-note">
          {mode === 'agent'
            ? 'This session writes a handoff note, the app saves it outside the project, then a fresh session starts by reading it.'
            : 'The app builds the note from its stored conversation — this session is not asked, so its drift cannot leak into the note.'}
        </p>
        {mode === 'agent' && blocked && (
          <p className="mt-2 text-xs leading-body text-ink-signal" data-testid="handoff-blocked">
            This session is waiting on {blocked === 'question' ? 'a question' : 'an approval'}. Asking for a note now would
            {blocked === 'question' ? ' answer the question with the handoff request' : ' drop the approval card'} —
            answer it first, or build the note from the record.
          </p>
        )}

        {/* Another tool does not inherit tool-specific settings (model, reasoning effort) */}
        <Badge as="p" className="mt-3">
          Hand off to
        </Badge>
        <Segmented
          label="Hand off to"
          layout="wrap"
          value={heirTool}
          onChange={setHeirTool}
          className="mt-1"
          options={tools.map((t) => ({
            value: t.name,
            label: t.label,
            testId: `handoff-tool-${t.name}`,
          }))}
        />

        {deleteOld ? (
          <p
            className="mt-3 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
            data-testid="handoff-warning"
          >
            When the new session is ready, this session is archived — and{' '}
            <span className="text-danger">deleting it for good there deletes the {toolLabel} conversation file
            too</span>. Until then, Settings → Archive reads it and restores it.
            {(working || backgroundTasks > 0) && (
              <span className="mt-1 block text-ink-signal" data-testid="handoff-stops-note">
                {working ? 'It is working now: the note holds what is stored so far, and archiving ends its turn' : 'Archiving stops it'}
                {backgroundTasks > 0 ? `${working ? ', and' : ' and'} its ${backgroundTasks} background task${backgroundTasks === 1 ? '' : 's'}` : ''}.
              </span>
            )}
          </p>
        ) : (
          <KeepNote backgroundTasks={backgroundTasks} />
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-xs ${
            'text-ink-muted hover:text-ink'
          }`}
          data-testid="handoff-delete-toggle"
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-ink-muted"
            checked={deleteOld}
            onChange={(e) => setDeleteOld(e.target.checked)}
          />
          <span>Archive this session after the handoff</span>
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink" onClick={onCancel}>
            Cancel
          </button>
          <Button
            variant="primary"
            onClick={() => onConfirm(heirTool, deleteOld, mode)}
            disabled={mode === 'agent' && !!blocked}
            data-testid="confirm-handoff-yes"
          >
            Hand off
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** The note when the original is kept; its running background work is the cost named (#1477) */
export function KeepNote({ backgroundTasks }: { backgroundTasks: number }) {
  return (
    <div className="mt-3 text-xs leading-body text-ink-muted" data-testid="handoff-keep-note">
      <p>This session stays — the new one starts from the note alongside it.</p>
      {backgroundTasks > 0 && (
        <p className="mt-1 text-ink-signal" data-testid="handoff-background-note">
          It still has {backgroundTasks} background task{backgroundTasks === 1 ? '' : 's'} running; when{' '}
          {backgroundTasks === 1 ? 'it ends' : 'one ends'}, this session wakes for a turn.
        </p>
      )}
    </div>
  )
}
