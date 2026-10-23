import { useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useToolMeta, useTools } from '../../../store/selectors.js'
import { Modal } from '../../../components/Modal.jsx'
import { Badge } from '../../../components/Badge.jsx'
import { Button } from '../../../components/Button.jsx'
import { Segmented } from '../../../components/Segmented.jsx'

/**
 * The handoff confirmation dialog (a dogfooding request).
 *
 * States the whole sequence in sentences — because this one button bundles three steps together:
 * "ask for a note → new session → (by default) actually delete." Since destruction is at the end,
 * the warning stands in the delete palette (the same grammar as project deletion). Typing the name
 * is not required: if the last step fails, nothing is lost, there are just two sessions left over,
 * and if it succeeds, the only thing lost is exactly what the person just read and approved.
 *
 * The receiving agent can be chosen (a dogfooding request) — the note is plain text, so it does
 * not lock in a tool. It defaults to the current tool. Archiving is also a checkbox, on by default
 * (#1477): turning it off turns this from switching tools into branching.
 */
export function ConfirmHandoff({
  name,
  tool,
  dead,
  blocked,
  backgroundTasks,
  onConfirm,
  onCancel,
}: {
  name: string
  tool: ToolName
  /** A session unable to respond due to an error or a rate limit (#78) — the receiving tool defaults to the other one */
  dead: boolean
  /** A card currently up (#174) — while one is up, the agent cannot be asked. The record mode does not ask, so it goes through as is */
  blocked: 'question' | 'approval' | null
  /** How many background tasks of this session run now (#290, ambient ones left out): a kept original is woken by each one's end (#1477) */
  backgroundTasks: number
  onConfirm: (tool: ToolName, deleteOld: boolean, mode: 'agent' | 'record') => void
  onCancel: () => void
}) {
  /*
   * The note comes from the record by default, for every session (owner decision on #694): the
   * session being replaced is the one least likely to summarize correctly, and a note it writes can
   * carry its drift or injected text. Asking the agent stays one click away.
   *
   * Archiving defaults to **on**, for both note sources (#1477, owner direction). It was off since #694
   * (#78's pairing: keep the original until the successor is known to work), but a kept original is not
   * idle: its process keeps running, and when one of its background tasks ends it wakes for a turn that rewrites
   * its whole context (after an hour idle the cache has expired), its finished children stay with it
   * (#1475), and two sessions claim one piece of work. Archiving is not deleting: the original stays in the
   * archive and can be restored, so the safety the old default gave is still there. The box stays, so
   * branching (keeping both) is one click, and when it is off and the original has background work running
   * the dialog says what that costs.
   *
   * For a dead session (#78) the target defaults to **the other tool**: if the service is down and
   * that is why the handoff is happening, defaulting to the same tool is a one-click trap. Only the
   * initial values are set — changing one radio afterward never silently changes another selection
   * (no silent actions).
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

        {/* Where the note comes from — the app builds it from the transcript by default (#694), or the session writes it itself */}
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

        {/* The receiving agent — choosing a different tool does not carry over tool-specific settings like model or reasoning effort */}
        <Badge as="p" className="mt-3">
          Hand off to
        </Badge>
        <Segmented
          label="Hand off to"
          value={heirTool}
          onChange={setHeirTool}
          className="mt-1"
          options={tools.map((t) => ({
            value: t.name,
            label: (
              <>
                {t.label}
                {t.name === tool && <span className="ml-1 text-2xs text-ink-faint">(current)</span>}
              </>
            ),
            testId: `handoff-tool-${t.name}`,
          }))}
        />

        {deleteOld ? (
          <p
            className="mt-3 rounded-md border border-danger/40 bg-danger-bg px-2.5 py-2 text-xs leading-body text-ink"
            data-testid="handoff-warning"
          >
            When the new session is ready, this session is archived — and{' '}
            <span className="text-danger">deleting it for good there deletes the {toolLabel} conversation file
            too</span>. Until then, Settings → Archive reads it and restores it.
          </p>
        ) : (
          <KeepNote backgroundTasks={backgroundTasks} />
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-xs ${
            deleteOld ? 'text-danger' : 'text-ink-muted hover:text-ink'
          }`}
          data-testid="handoff-delete-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteOld ? 'accent-danger' : 'accent-ink-muted'}`}
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
            variant={deleteOld ? 'danger' : 'primary'}
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

/**
 * What the dialog says when the original is kept (the box is off). Background work still running in it is the cost worth
 * naming (#1477): the end of each task wakes the session for a turn nobody asked for.
 */
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
