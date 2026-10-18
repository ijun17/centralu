import { useCallback, useEffect, useRef, useState } from 'react'
import type { SavedCommand } from '@cc/protocol'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { useOpenLayer } from '../../components/Modal.jsx'
import { isPlainEnter, isPlainEscape } from '../../app/keys.js'
import { CommandLogView } from '../../components/CommandLogView.jsx'
import { useStore } from '../../store/store.js'

const NO_COMMANDS: SavedCommand[] = []
const NO_RUNS: Record<string, never> = {}

/**
 * Frequently used commands (#60) — a run window separate from the terminal tab.
 *
 * It used to be that picking one from the small popover in the header would **type it into the
 * terminal tab's PTY**. That meant one-off builds and dev servers alike all settled into the
 * terminal tab, and the narrow popover had no room to show logs either. For a while this was a
 * window covering the whole pane, but a full screen for a handful of list rows was too much
 * (reported by a user on 2026-09-06) — now it is a small window centered on screen, and the log
 * only opens below once a command is picked.
 *
 * The alias (label) was requested the same day: "dev server" reads at a glance better than
 * `pnpm dev`. There is one rule to stop the name from drifting into quietly meaning a different
 * command, though — **every place that shows the alias shows the command too.** Identity always
 * belongs to the command string.
 *
 * One-off and long-running commands are **not distinguished** — if it does not end, the log
 * just keeps streaming, and if it does, the log is left behind along with the exit code. A dev
 * server is simply a command that does not end. Only the single most recent run's log per
 * command is kept on the host (for the app's lifetime) — closing and reopening the window
 * leaves it unchanged **until the same command is run again** (decided by a user on 2026-08-26).
 *
 * Run state belongs not to this window but to the store's record (commandRuns) — even with the
 * window closed, **a running command still stands as a terminal in the terminal panel**, and an
 * exit, wherever it came from, goes through the record and shows up in both places together.
 * The window is the source of truth for registering, running and past logs; the panel is where
 * it lives.
 */
export function CommandRunnerOverlay({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const runCommand = useStore((s) => s.runCommand)
  const stopCommand = useStore((s) => s.stopCommand)
  const [selected, setSelected] = useState<string | null>(null)
  /** Command → last run state (for the badge). LogView holds the log body separately */
  const runs = useStore((s) => s.commandRuns[projectId] ?? NO_RUNS)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  /** The command whose alias is being edited (the command string is the key) */
  const [renaming, setRenaming] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Mid closing-animation — only unmounts via onClose after sliding back up the way it came down */
  const [leaving, setLeaving] = useState(false)
  const leave = useCallback(() => setLeaving(true), [])
  // A layer that covers the pane — while it is open, the approval card underneath does not
  // receive y/n/a (#158)
  useOpenLayer()

  // With reduced-motion, animationend never fires — a timer guarantees the unmount (the same
  // rule as the settings menu)
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(onClose, 200)
    return () => window.clearTimeout(t)
  }, [leaving, onClose])

  // Reads the host's run record on open — a run keeps going even if the window is closed, so
  // reopening it picks up where it left off.
  // (The grid has no evidence panel, so this also has to be read here — the grid path right
  // after a UI reload)
  useEffect(() => {
    void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return
      e.stopPropagation()
      // While editing an alias, Esc cancels the edit — closing the window too would collapse
      // both steps at once
      if (renaming !== null) setRenaming(null)
      else leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [leave, renaming])

  // Running and stopping both go through the store's record — the terminal panel and tab badge
  // see the same fact (the failure toast comes from there too)
  const run = (command: string) => void runCommand(projectId, command)
  const stop = (command: string) => void stopCommand(projectId, command)

  const add = () => {
    const command = draft.trim()
    if (!command) return
    const label = draftName.trim()
    setDraft('')
    setDraftName('')
    void save(projectId, [...commands, { command, ...(label ? { label } : {}) }])
  }

  const rename = (command: string, label: string) => {
    setRenaming(null)
    const clean = label.trim()
    void save(
      projectId,
      commands.map((c) => (c.command === command ? { command, ...(clean ? { label: clean } : {}) } : c)),
    )
  }

  const sel = selected ? commands.find((c) => c.command === selected) : undefined
  const current = sel?.command ?? null
  const currentRun = current ? runs[current] : undefined

  return (
    /* Clicking the outer margin closes it — ignored if the window itself started the mousedown */
    <div
      ref={rootRef}
      className="absolute inset-0 z-40 flex items-start justify-end bg-surface-floor/40 px-2 pb-4 pt-8"
      data-testid="run-menu"
      onMouseDown={(e) => {
        if (e.target === rootRef.current) leave()
      }}
    >
      {/*
        Attaches as a dropdown below the header's ▶ (requested by a user on 2026-09-06 — a
        centered modal felt too heavy for a handful of list rows). The cc-drop animation
        sliding down from above tells where it came from. The window is only as tall as its
        content, and grows downward once the log is opened.
      */}
      <div
        onAnimationEnd={() => leaving && onClose()}
        className={`flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-md border border-line bg-surface-raised shadow-(--shadow-dropdown) ${
          leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'
        }`}
      >
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span className="text-xs uppercase text-ink-faint">Commands</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={leave} testId="run-close" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </div>

        {/*
          The command list.

          Rows do not each get a border. They used to be `border-line bg-surface-floor` boxes, and
          since the input just below in the registration area had the exact same shell,
          **the list looked like a row of empty input fields** (reported by a user on
          2026-09-07). But giving rows no background at all makes the list blend into the
          window background and hides where it starts (a second issue reported the same day).

          So **the whole list is one panel, not individual rows**: hairline rules separate the
          rows on top of a floor (bg-surface-floor) one shade darker than the window. A bordered box is
          still reserved for places that take text input, and the list is a settled slab, so
          there is no room to confuse it with an input.
        */}
        <div className="max-h-64 shrink-0 overflow-y-auto border-b border-line bg-surface-floor">
          {commands.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-faint">
              No saved commands yet — add one below. It runs in the project folder.
            </p>
          )}
          {commands.map((c, i) => {
            const r = runs[c.command]
            return (
              <div
                key={`${i}-${c.command}`}
                className={`group/row flex items-center border-b border-line/60 transition-colors last:border-b-0 ${
                  current === c.command ? 'bg-surface-hover/50' : 'hover:bg-surface-hover/25'
                }`}
              >
                <button
                  type="button"
                  data-testid={`run-command-${i}`}
                  onClick={() => setSelected(c.command)}
                  className="min-w-0 flex-1 px-3 py-1.5 text-left"
                >
                  {renaming === c.command ? (
                    <TextInput
                      size="xs"
                      surface="raised"
                      autoFocus
                      defaultValue={c.label ?? ''}
                      placeholder="Name (blank removes it)"
                      data-testid={`run-rename-input-${i}`}
                      className="w-full"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // An Enter that ends a composition does not save (#181) — the last
                        // syllable of a Korean-language alias was dropped
                        if (isPlainEnter(e.nativeEvent))
                          rename(c.command, (e.target as HTMLInputElement).value)
                        // Esc is only cleared from `renaming` by the window listener above
                      }}
                      onBlur={(e) => renaming === c.command && rename(c.command, e.target.value)}
                    />
                  ) : c.label ? (
                    <>
                      <span className="block truncate text-sm text-ink">{c.label}</span>
                      <span className="readout block truncate text-2xs text-ink-faint">{c.command}</span>
                    </>
                  ) : (
                    <span className="readout block truncate py-0.5 text-sm text-ink-muted transition-colors group-hover/row:text-ink">
                      {c.command}
                    </span>
                  )}
                </button>
                {/* Status shows in the list too — the moment the window opens, "which one is
                running" must be readable */}
                {r?.running && (
                  <span
                    className="mr-1 size-1.5 shrink-0 animate-pulse rounded-full bg-ink"
                    data-testid={`run-running-${i}`}
                    aria-label="running"
                  />
                )}
                {r && !r.running && (
                  <span className="readout mr-1 shrink-0 text-2xs text-ink-faint" data-testid={`run-exit-${i}`}>
                    exit {r.exitCode ?? '?'}
                  </span>
                )}
                {/* Adding/editing an alias — hover only (a permanent button set on every row
                would make the list noisy) */}
                <button
                  type="button"
                  data-testid={`run-rename-${i}`}
                  aria-label={`Rename ${c.command}`}
                  onClick={() => setRenaming(c.command)}
                  className="shrink-0 px-1.5 py-1.5 text-2xs text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/row:opacity-100"
                >
                  {c.label ? 'Rename' : 'Name'}
                </button>
                {/* Delete is a different target from run — extra spacing on the side where a
                wrong click cannot be undone */}
                <button
                  type="button"
                  data-testid={`run-delete-${i}`}
                  aria-label={`Remove ${c.command}`}
                  onClick={() => {
                    if (current === c.command) setSelected(null)
                    void save(projectId, commands.filter((_, j) => j !== i))
                  }}
                  className="shrink-0 rounded-r-md px-2 py-1.5 text-ink-faint transition-colors hover:bg-surface-hover/70 hover:text-ink"
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            )
          })}
        </div>

        {/* Registration — a panel at the bottom, not the list's last row. Where the slab ends
        is the boundary */}
        <div className="shrink-0 p-2">
          <div className="flex items-center gap-1">
            <TextInput
              size="md"
              text="sm"
              font="readout"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e.nativeEvent)) add()
              }}
              placeholder="Command, e.g. pnpm dev"
              data-testid="run-add-input"
              className="min-w-0 flex-1"
            />
            <TextInput
              size="md"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter(e.nativeEvent)) add()
              }}
              placeholder="Name (optional)"
              data-testid="run-add-name"
              className="w-32 shrink-0"
            />
            {/* As tall as the fields beside it: the small button alone would sit shorter than them */}
            <Button variant="quiet" size="sm" data-testid="run-add" onClick={add} className="shrink-0 self-stretch">
              Add
            </Button>
          </div>
        </div>

        {/* Run, stop, log — only once a command is picked. Until then the window stays as
        small as the list */}
        {current && (
          <>
            <div className="flex items-center gap-2 border-y border-line px-3 py-1.5">
              <Button variant="secondary" size="md" data-testid="run-exec" onClick={() => void run(current)}>
                {currentRun?.running ? 'Restart' : 'Run'}
              </Button>
              {currentRun?.running && (
                <Button variant="quiet" size="md" data-testid="run-stop" onClick={() => void stop(current)}>
                  Stop
                </Button>
              )}
              <span className="readout min-w-0 truncate text-xs text-ink-faint" data-testid="run-selected">
                {sel?.label ? `${sel.label} · ${current}` : current}
              </span>
            </div>

            {/* The selected command's log — re-renders from scratch when runId changes (re-run) */}
            <div className="h-64 min-h-0 shrink" data-testid="run-log">
              {currentRun ? (
                <CommandLogView
                  key={currentRun.runId}
                  projectId={projectId}
                  command={current}
                  runId={currentRun.runId}
                  surfaceTestId={`run-log-surface-${currentRun.runId}`}
                />
              ) : (
                <p className="px-3 py-2 text-xs text-ink-faint">Not run yet — press Run.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
