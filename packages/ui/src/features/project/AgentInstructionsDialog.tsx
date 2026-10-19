import { useState } from 'react'
import { AGENT_INSTRUCTIONS_MAX, type ProjectInfo } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Modal } from '../../components/Modal.jsx'
import { Button } from '../../components/Button.jsx'
import { textInputClass } from '../../components/TextField.jsx'

/**
 * The project's instructions for the agents started in it (#1161 item 2), opened from the project's menu.
 *
 * Every start_agent task given in this project carries them after the task, so the rules a parent repeated in each brief
 * (make your own worktree, stack the pull requests, never use git stash) are written once. They are this machine's copy
 * of the project's: a project on a linked machine keeps its own (its paths, its shell), and that machine's are the ones
 * a child started there reads. The dialog says both, since nothing else on screen shows where the text goes.
 */
export function AgentInstructionsDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const save = useStore((s) => s.saveAgentInstructions)
  const [text, setText] = useState(project.agentInstructions)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = text.trim() !== project.agentInstructions

  return (
    <Modal onClose={onClose} testId="agent-instructions-dialog">
      <form
        className="w-[560px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          setError(null)
          try {
            await save(project.id, text)
            onClose()
          } catch (err) {
            // Kept in the dialog with the text, as the delete dialog keeps its error: a toast would lose what was typed
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <h2 className="text-md font-medium text-ink">
          Instructions for agents <span className="text-ink-faint">·</span>{' '}
          <span className="text-ink-muted">{project.name}</span>
        </h2>
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="agent-instructions-note">
          Added after the task of every agent a session starts in this project with start_agent.
          {project.machine
            ? ` These are ${project.machine}'s: an agent started there reads them, with its paths and its shell.`
            : ' An agent started on a linked machine reads that machine’s copy of the project’s instead.'}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={AGENT_INSTRUCTIONS_MAX}
          autoFocus
          spellCheck={false}
          rows={12}
          aria-label="Instructions for agents started in this project"
          placeholder="Make your own worktree. Never use git stash."
          data-testid="agent-instructions-input"
          className={`${textInputClass({ font: 'mono' })} mt-3 block w-full resize-y leading-body`}
        />
        {error && (
          <p
            className="mt-3 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
            data-testid="agent-instructions-error"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <Button type="submit" variant="primary" disabled={!changed || busy} data-testid="agent-instructions-save">
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
