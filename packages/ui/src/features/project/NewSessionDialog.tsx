import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RelativeAge } from '../../components/RelativeAge.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { errorMessage, defaultPresetFor, type ExternalSession, type GitBranch } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { formatBytes } from '../../app/format.js'
import { isTextEntry } from '../../app/keys.js'
import { useSessionsOf, useTools } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { Button } from '../../components/Button.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { MachineTag } from '../machines/MachineTag.jsx'
import { useToolChoice } from './useToolChoice.js'
import { ToolSetupLine } from '../tools/ToolSetupLine.jsx'
import { TrustProjectButton } from './TrustCard.jsx'
import { envFilesOf, installCommandFor } from './worktreeSuggestions.js'

/** 'unsupported' is a normal outcome, not an error: an older tool cannot list, and a new session must still start. */
type PastState =
  | { status: 'loading' }
  | { status: 'ok'; sessions: ExternalSession[] }
  | { status: 'unsupported'; reason: string }

/** One comma-separated list (#76). Saving splits the same way, or a pressed chip could not be pressed back out. */
const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

/**
 * Session creation (FR-7). Only the tool (it is the process) and "new vs. resume" are chosen here; model and
 * permissions change from the header later. No first-prompt field: the session opens on its own composer, and the
 * naming rule (FR-18) applies to its first message. Fixed header and footer with a scrolling body (as Settings and
 * Inbox), so the worktree fields never push Start off screen.
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const saveWorktreeSetup = useStore((s) => s.saveWorktreeSetup)
  const running = useSessionsOf(projectId)
  // A worktree needs a git repository; the checkbox is only drawn in one
  const isRepo = !!project?.git

  // The buttons come from the connect-time list; `tools` is asked again on open, as install or login may have changed
  const allTools = useTools()
  const machine = project?.machine ?? null
  // What the start asks of the tool: the project's trust, and the preset a new session starts with
  const { tool, setTool, toolMeta, tools, info, usable, refusal, blocked, detectError, redetect } = useToolChoice(
    project?.defaultTool ?? allTools[0]?.name ?? '',
    machine,
    { permissionPreset: defaultPresetFor({ trusted: !!project?.trusted }), projectTrusted: !!project?.trusted },
  )
  const [busy, setBusy] = useState(false)
  /**
   * Run this session in a worktree (FR-2). Off by default, as the spec works in the original directory; already on
   * when opened from the + on a manager row (#69). Only the initial value: read once per mount.
   */
  const [worktree, setWorktree] = useState(useStore.getState().newSessionWorktree)
  /** The branch name (#69), also the session and directory name, so it is set before creation. Blank: the host names it. */
  const [branch, setBranch] = useState(useStore.getState().newSessionBranch)
  // Provisioning (#69): a one-line summary once saved, expanded on first use, when "node_modules is missing" comes up
  const savedSetup = project?.worktreeSetup ?? null
  const [setupOpen, setSetupOpen] = useState(!savedSetup)
  const [setupCommand, setSetupCommand] = useState(savedSetup?.command ?? '')
  const [copyFiles, setCopyFiles] = useState(savedSetup?.copyFiles.join(', ') ?? '')
  const [error, setError] = useState<string | null>(null)
  /**
   * Where the branch forks from: the manager's trunk, else the current branch, written out instead of happening
   * silently. The list only assists, so an unreadable one does not block creation (as in the manager dialog).
   */
  const trunk = project?.worktreeManager?.baseBranch || project?.git?.branch || ''
  /**
   * null = untouched, so the field shows the trunk; '' = cleared by the person, left to the host's order. Not
   * initialized to the trunk: where git info arrives late, the field would stay empty.
   */
  const [base, setBase] = useState<string | null>(null)
  const baseValue = base ?? trunk
  // Read once a worktree is asked for; a failed read offers none and the base stays the trunk
  const branches: GitBranch[] | null =
    useLoad(
      () => (isRepo && worktree ? platform.git.branches(projectId).then((list) => list.filter((b) => !b.remote)) : null),
      [isRepo, worktree, platform, projectId],
    ).data ?? null

  /**
   * Copy candidates (#76): what git ignores, so what a new worktree lacks. Offered, never preselected: "copy all
   * ignored" would drag 637MB of node_modules and an 8.5GB Rust target here. Sizes are shown instead.
   */
  const ignored: { path: string; bytes: number | null }[] | null =
    useLoad(() => (isRepo && worktree ? platform.git.ignoredEntries(projectId) : null), [isRepo, worktree, platform, projectId]).data ?? null

  // A project's first worktree (#1512): with nothing saved, chips offer the lockfile's install command and the ignored
  // `.env` files. Read only then, once a worktree is asked for.
  const lockfileNames: string[] | null =
    useLoad(
      () =>
        isRepo && worktree && !savedSetup ? platform.fs.listDir(projectId, '').then((rows) => rows.filter((r) => !r.isDir).map((r) => r.name)) : null,
      [isRepo, worktree, savedSetup, platform, projectId],
    ).data ?? null
  const installCommand = lockfileNames ? installCommandFor(lockfileNames) : null
  const envFiles = envFilesOf((ignored ?? []).map((e) => e.path))

  // The past session to resume. null means 'new session' (the default)
  const [resume, setResume] = useState<ExternalSession | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusSession = useStore((s) => s.focusSession)
  const askComposerFocus = useStore((s) => s.askComposerFocus)


  /**
   * Scrolls the arrow-picked row into view, only when the pick changes. Not from the row's inline ref: React reattaches
   * it on every render, and every store event re-renders this, which yanked the scroll back (measured: 324 to 13 outer,
   * 1140 to 0 inner, on one event). `block: 'nearest'` leaves a visible row alone, so mouse picks do not jump.
   */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [resume?.externalId])

  // The previous pick belonged to another tool's list
  useEffect(() => setResume(null), [platform, projectId, tool])
  const listed = useLoad(() => platform.agents.listExternalSessions(projectId, tool), [platform, projectId, tool])
  const past: PastState =
    listed.error !== null
      ? { status: 'unsupported', reason: listed.error }
      : listed.data === undefined
        ? { status: 'loading' }
        : listed.data.supported
          ? { status: 'ok', sessions: listed.data.sessions }
          : { status: 'unsupported', reason: listed.data.reason ?? 'Could not list past conversations' }

  // A total, since what a person judges from this list is "this is too big"
  const picks = splitList(copyFiles)
  const pickedBytes = (ignored ?? [])
    .filter((e) => picks.includes(e.path))
    .reduce((n, e) => n + (e.bytes ?? 0), 0)

  return (
    <Modal onClose={onClose} testId="new-session-dialog" align="top">
      <form
        className="flex max-h-[calc(82vh/var(--text-zoom))] w-[480px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
        onKeyDown={(e) => {
          // Arrows pick in the list, so resuming works without a mouse (⌘N ↓↓ ↵). Open conversations are skipped: their
          // row jumps and closes. Not in a text field (#181): ↓ in Branch would pick a session for the next Enter, and
          // the From datalist would not open.
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && past.status === 'ok' && !isTextEntry(e.target)) {
            e.preventDefault()
            const rows: (ExternalSession | null)[] = [null, ...past.sessions.filter((s) => !s.importedAs)]
            const at = rows.findIndex((r) => (r?.externalId ?? null) === (resume?.externalId ?? null))
            const next = rows[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)]
            setResume(next ?? null)
          }
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            // Saved before creation (#69): the host runs the saved setup while creating the worktree
            if (worktree && setupOpen) {
              const next = { command: setupCommand.trim(), copyFiles: splitList(copyFiles) }
              const changed =
                next.command !== (savedSetup?.command ?? '') ||
                next.copyFiles.join('\n') !== (savedSetup?.copyFiles ?? []).join('\n')
              if (changed)
                await saveWorktreeSetup(projectId, next.command || next.copyFiles.length ? next : null)
            }
            const created = await createSession(projectId, {
              tool,
              // A picked past session: the tool resumes it and its history is restored on screen
              resumeExternalId: resume?.externalId,
              importHistory: resume ? true : undefined,
              worktree: worktree || undefined,
              worktreeBranch: (worktree && branch.trim()) || undefined,
              // Sent as written; only an empty one is left to the host's order (trunk → HEAD)
              worktreeBase: (worktree && baseValue.trim()) || undefined,
            })
            // What comes next is the first instruction: the new session's composer takes the keyboard once this closes (#528)
            askComposerFocus(created.id)
            onClose()
          } catch (err) {
            // Kept in the modal: a toast vanishes after 2.5 s and reads as "nothing happened"
            setError(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        {/* Fixed header;
          only the body scrolls */}
        <header className="shrink-0 border-b border-line px-4 py-2.5">
          <h2 className="flex items-baseline gap-1.5 text-md font-medium text-ink">
            <span className="shrink-0">New session</span> <span className="text-ink-faint">·</span>{' '}
            <span className="truncate text-ink-muted">{project?.name}</span>
            {/* The machine it will run on (#82): the project decides it, so it is stated, not asked */}
            <MachineTag machine={machine} testId="new-session-machine" className="self-center font-normal" />
          </h2>
          {/* The tool, without a subheading */}
          <Segmented
            label="Tool"
            value={tool}
            onChange={setTool}
            className="mt-2.5"
            options={allTools.map((t) => ({
              value: t.name,
              label: t.label,
              testId: `tool-option-${t.name}`,
              title: refusal(t.name) ?? info(t.name)?.detail,
              dim: !!tools && !usable(t.name),
            }))}
          />
          {/* Why it cannot be used is said: a disabled button alone looks broken */}
          <ToolSetupLine
            status={info(tool)}
            label={toolMeta.label}
            login={toolMeta.login}
            machine={machine}
            shown={blocked}
            refusal={refusal(tool)}
            terminal={{
              login: (label, command) => `${label} needs a login — run ${command} in a terminal`,
              missing: (label, detail) => `${label} not found (${detail})`,
            }}
            redetect={() => void redetect()}
            testId="tool-blocked"
            className="mt-2 text-xs leading-body text-ink-muted"
          />
          {detectError && (
            <LoadFailed what="which tools are installed" error={detectError} onRetry={() => void redetect()} className="mt-2" testId="tool-detect-failed" />
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* The body: carrying a terminal
             conversation over as it was */}
          <div
            ref={listRef}
            className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface-raised"
            data-testid="past-sessions"
          >
            <PastRow
              selected={!resume}
              onSelect={() => setResume(null)}
              testId="past-new"
              title="Start a new conversation"
              meta=""
            />
            {past.status === 'loading' && (
              <SkeletonLines lines={3} className="px-2.5 py-2" label="Looking for past conversations" testId="past-loading" />
            )}
            {/* An older tool still allows a new session; the reason is stated quietly */}
            {past.status === 'unsupported' && (
              <p
                className="px-2.5 py-2 text-xs leading-body text-ink-faint"
                data-testid="past-unsupported"
              >
                Could not load past conversations — {past.reason}
              </p>
            )}
            {past.status === 'ok' && past.sessions.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-ink-faint" data-testid="past-empty">
                No past conversations in this folder.
              </p>
            )}
            {past.status === 'ok' &&
              past.sessions.map((s) => (
                <PastRow
                  key={s.externalId}
                  selected={resume?.externalId === s.externalId}
                  onSelect={() => {
                    // Already open: jump to it. Only marking the row let the same conversation open twice (measured).
                    if (s.importedAs) {
                      focusSession(s.importedAs)
                      askComposerFocus(s.importedAs)
                      onClose()
                      return
                    }
                    setResume(s)
                  }}
                  testId={`past-${s.externalId}`}
                  title={s.title}
                  /* The title is Claude's summary but Codex's first user message, so the last activity is stated
                     beside it, or a recent conversation would look old. */
                  meta={<>
                    last <RelativeAge when={s.updatedAt} />
                    {s.branch && ` · ${s.branch}`}
                    {s.importedAs && ' · Already open · click to jump'}
                  </>}
                />
              ))}
          </div>

          {/* The warning sits by its fix, a worktree;
             the checkbox only in a repository */}
          {running.length > 0 && (
            <p className="mt-2.5 text-xs leading-body text-ink-muted" data-testid="concurrent-warning">
              {running.length} sessions are already running in this directory. Editing the same files can lose
              changes.
            </p>
          )}
          {isRepo && (
            <label
              className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-ink-muted hover:text-ink"
              data-testid="worktree-toggle"
            >
              <input
                type="checkbox"
                className="accent-ink-muted"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              <span>
                Run in a git worktree
                <span className="text-ink-faint"> — own branch and directory, can’t touch the others’ files</span>
              </span>
            </label>
          )}
          {/* Details once on, in one block (as in the delete dialog)
             so they read as the checkbox's */}
          {isRepo && worktree && (
            <div
              className="mt-2 space-y-2.5 rounded-md border border-line bg-surface-raised p-2.5"
              data-testid="worktree-options"
            >
              {/* Refused by the host for a project that is not trusted (checking out runs its hooks): said before the press, with the way out (#1512) */}
              {project && !project.trusted && (
                <div className="text-xs leading-body text-ink-muted" data-testid="worktree-untrusted">
                  <p>A worktree needs a trusted project: checking it out runs the repository&apos;s hooks.</p>
                  <TrustProjectButton projectId={project.id} testId="worktree-untrusted-trust" className="mt-1.5" />
                </div>
              )}
              {/* The hint names what blank yields: the host's
                 `centralu/<first 8 chars of the session id>` (manager.ts) */}
              <Field label="Branch" hint="blank = centralu/<session id>">
                <TextInput
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/…"
                  data-testid="worktree-branch-input"
                  spellCheck={false}
                  font="mono"
                  className="w-full"
                />
              </Field>
              {/* Where the new branch forks from */}
              <Field label="From" hint="the new branch forks from here">
                <TextInput
                  type="text"
                  value={baseValue}
                  onChange={(e) => setBase(e.target.value)}
                  list="worktree-base-options"
                  placeholder={trunk || 'current branch'}
                  data-testid="worktree-base-input"
                  spellCheck={false}
                  font="mono"
                  className="w-full"
                />
                <datalist id="worktree-base-options">
                  {(branches ?? []).map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
              </Field>
              {/* Provisioning (#69): a new worktree has tracked files only.
                 Runs at creation: copy, then setup */}
              {setupOpen ? (
                <div className="space-y-2.5" data-testid="worktree-setup-edit">
                  {/* Offered only before anything is saved: pressing one fills the field it names, and pressing it again takes it out */}
                  {!savedSetup && (installCommand || envFiles.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5" data-testid="worktree-first-suggestions">
                      <span className="text-2xs text-ink-faint">Suggested for a new worktree:</span>
                      {installCommand && (
                        <Button
                          variant="subtle"
                          size="xs"
                          className="font-mono"
                          data-testid="suggest-install"
                          onClick={() => setSetupCommand(setupCommand.trim() === installCommand ? '' : installCommand)}
                        >
                          {setupCommand.trim() === installCommand ? '✓ ' : ''}run {installCommand}
                        </Button>
                      )}
                      {envFiles.length > 0 && (
                        <Button
                          variant="subtle"
                          size="xs"
                          className="font-mono"
                          data-testid="suggest-env"
                          onClick={() => {
                            const all = envFiles.every((f) => picks.includes(f))
                            setCopyFiles((all ? picks.filter((f) => !envFiles.includes(f)) : [...new Set([...picks, ...envFiles])]).join(', '))
                          }}
                        >
                          {envFiles.every((f) => picks.includes(f)) ? '✓ ' : ''}copy {envFiles.join(', ')}
                        </Button>
                      )}
                    </div>
                  )}
                  <Field label="Setup command" hint="runs once, in the new worktree">
                    <TextInput
                      type="text"
                      value={setupCommand}
                      onChange={(e) => setSetupCommand(e.target.value)}
                      placeholder="pnpm install"
                      data-testid="worktree-setup-command"
                      spellCheck={false}
                      font="mono"
                      className="w-full"
                    />
                  </Field>
                  <Field label="Copy from the project" hint="comma-separated">
                    <TextInput
                      type="text"
                      value={copyFiles}
                      onChange={(e) => setCopyFiles(e.target.value)}
                      placeholder=".env.local"
                      data-testid="worktree-copy-files"
                      spellCheck={false}
                      font="mono"
                      className="w-full"
                    />
                    {/* Chips toggle entries in the field above (#76);
                       the field stays the one source */}
                    {ignored && ignored.length > 0 && (
                      <div className="mt-1.5" data-testid="worktree-ignored-suggestions">
                        <ul className="flex flex-wrap gap-1">
                          {ignored.map((e) => {
                            const picked = picks.includes(e.path)
                            return (
                              <li key={e.path}>
                                <button
                                  type="button"
                                  data-testid={`ignored-${e.path}`}
                                  onClick={() => {
                                    const next = picked
                                      ? picks.filter((f) => f !== e.path)
                                      : [...picks, e.path]
                                    setCopyFiles(next.join(', '))
                                  }}
                                  className={`rounded-md border px-1.5 py-0.5 font-mono text-2xs transition-colors ${
                                    picked
                                      ? 'border-ink-muted bg-surface-hover/40 text-ink'
                                      : 'border-line text-ink-faint hover:border-line-strong hover:text-ink-muted'
                                  }`}
                                >
                                  {e.path}
                                  {e.bytes !== null && (
                                    <span className="ml-1 text-ink-faint">{formatBytes(e.bytes)}</span>
                                  )}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                        {/* The total: people do not add the chip sizes up,
                           and one Rust target is 8.5GB */}
                        {picks.length > 0 && (
                          <p className="mt-1.5 text-2xs text-ink-faint" data-testid="copy-total">
                            {picks.length} to copy{pickedBytes > 0 ? ` · ~${formatBytes(pickedBytes)}` : ''}
                            {pickedBytes > 1024 ** 3 && (
                              <span className="text-ink-muted"> — every worktree pays this again</span>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </Field>
                </div>
              ) : (
                <Button
                  variant="subtle"
                  size="xs"
                  data-testid="worktree-setup-summary"
                  onClick={() => setSetupOpen(true)}
                  className="block w-full truncate text-left font-mono"
                  title="Edit worktree setup"
                >
                  {savedSetup?.command ? `setup: ${savedSetup.command}` : 'setup: (none)'}
                  {savedSetup?.copyFiles.length ? ` · copies: ${savedSetup.copyFiles.join(', ')}` : ''}
                </Button>
              )}
            </div>
          )}

          {error && (
            <p
              className="mt-3 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
              data-testid="create-session-error"
            >
              {error}
            </p>
          )}
        </div>

        {/* No shortcut hint: ↑↓ ↵ esc are
           known from any list dialog */}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-2.5">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink"
            onClick={onClose}
          >
            Cancel
          </button>
          <Button
            type="submit"
            variant="primary"
            /* With no input field, Enter means start — this needs to hold the default focus */
            autoFocus
            // A worktree is refused in a project that is not trusted, and the setup typed here would be saved before that: trust it first (#1512)
            disabled={busy || blocked || (worktree && !!project && !project.trusted)}
            data-testid="create-session-confirm"
          >
            {busy ? (resume ? 'Loading…' : 'Starting…') : resume ? 'Load' : 'Start'}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}

/**
 * A label plus a field. Instructions go in the label: a placeholder vanishes once typing starts and truncates at 480px.
 * A div, not a label: a click on a chip inside a label would move focus to the field.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-2xs text-ink-muted">
        {label}
        {hint && <span className="text-ink-faint"> · {hint}</span>}
      </p>
      {children}
    </div>
  )
}

/** One list row. Selection shows by brightness alone (the grayscale rule); a checkbox would read as a setting. */
function PastRow({
  selected,
  onSelect,
  title,
  meta,
  testId,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  meta: ReactNode
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      aria-pressed={selected}
      className={`flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? 'border-l-ink-muted bg-surface-hover/40 text-ink'
          : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
      }`}
    >
      <span className="truncate text-sm leading-tight">{title}</span>
      {meta && <span className="readout truncate text-2xs text-ink-faint">{meta}</span>}
    </button>
  )
}
