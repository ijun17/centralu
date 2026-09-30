import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ExternalSession, GitBranch, ToolName, ToolStatus } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { isTextEntry } from '../../app/keys.js'
import { useSessionsOf, useToolMeta, useTools } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'

/** What one field looks like. All three must share a shape to read as "the same kind of answer" */
const inputClass =
  'w-full rounded border border-edge bg-void px-2 py-1.5 font-mono text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none'

/**
 * The state of the past sessions list.
 * 'unsupported' is not a failure, it is **a normal outcome** — an older tool version cannot
 * provide the list. A new session still has to be creatable then, so it is not treated as an error.
 */
type PastState =
  | { status: 'loading' }
  | { status: 'ok'; sessions: ExternalSession[] }
  | { status: 'unsupported'; reason: string }

/**
 * Reads one comma-separated list (#76).
 *
 * **Must use the same rule** as when it is saved (copyFiles.split below) — if the suggestion chip
 * counted "is this already picked" differently, a pressed-in item could end up unable to be pressed
 * back out.
 */
const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

/** 630MB · 8.5GB — only the order of magnitude has to be right. This number states scale, not precision */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)}KB`
  const mb = kb / 1024
  return mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`
}

/** just now · 32m ago · 3h ago · 5d ago — "how long ago" matters more than the exact time */
function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/**
 * Session creation (FR-7).
 *
 * **The only things chosen here are the tool and "start fresh vs. resume."** Model and permissions
 * are changed from the header after the session is created — something changeable while talking to
 * it is actually more useful than something fixed before starting. (Tool is the one exception,
 * because it is the process itself and cannot be changed partway through.)
 *
 * **There is no first-prompt input field** (dogfooding, 2026-08-27: "this feels crude, and is it
 * even necessary?"). It goes straight to a screen with its own input field the moment it is
 * created, so there is no reason to type ahead of that in a dialog — the rule for what becomes the
 * session name (FR-18) applies identically to the input field's first message (the manager rewrites
 * the first sentence sent as 'New session'). The subheading and helper text were removed for the
 * same reason: this dialog's body is nothing but the conversation list.
 *
 * The frame matches the other dialogs (Settings, Inbox) — **fixed header / scrolling body / fixed
 * footer.** The tool row and the start button must stay in place no matter how long the dialog
 * grows, and only the middle (the conversation list, worktree settings) is allowed to grow. The
 * whole dialog used to grow instead, and turning on the worktree option and expanding the
 * suggestions pushed the start button off screen.
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const saveWorktreeSetup = useStore((s) => s.saveWorktreeSetup)
  const running = useSessionsOf(projectId)
  // A worktree can only be created in a git repository — otherwise the checkbox is disabled and the reason is stated
  const isRepo = !!project?.git

  /**
   * The list that builds the row of tool buttons is what was received at connect time, while
   * `tools` below is asked for **again, when this dialog opens.** The list itself never changes,
   * but whether a tool is installed or logged in may have just changed.
   */
  const allTools = useTools()
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [tool, setTool] = useState<ToolName>(project?.defaultTool ?? allTools[0]?.name ?? '')
  const toolMeta = useToolMeta(tool)
  const [busy, setBusy] = useState(false)
  /**
   * Run only this session in a worktree (an FR-2 option).
   *
   * **Defaults to off.** The spec's stated principle is "work directly in the original directory,"
   * and a worktree is an isolation mechanism that only a person who wants it turns on. The one
   * exception is opening it from the + on a manager row (#69) — there it opens already turned on.
   * That is a head start, not a requirement: turning it off is free, and since this is only the
   * initial value, the store is not re-read again while the dialog stays open (read once per mount).
   */
  const [worktree, setWorktree] = useState(useStore.getState().newSessionWorktree)
  /**
   * The branch name (#69). The branch name is also the session name and the directory name —
   * effectively permanent, so there has to be a place to set it before creation. Leaving it blank
   * lets the host use an automatic name (no requirement to fill it in).
   */
  const [branch, setBranch] = useState(useStore.getState().newSessionBranch)
  /**
   * Provisioning (#69). Shown as a collapsed one-line summary if a setting is already saved, and
   * expanded if there is none (first use) — right when the thought "oh, node_modules needs to be
   * installed" first comes up, the input field needs to already be in front of the person.
   */
  const savedSetup = project?.worktreeSetup ?? null
  const [setupOpen, setSetupOpen] = useState(!savedSetup)
  const [setupCommand, setSetupCommand] = useState(savedSetup?.command ?? '')
  const [copyFiles, setCopyFiles] = useState(savedSetup?.copyFiles.join(', ') ?? '')
  const [error, setError] = useState<string | null>(null)
  /**
   * Copy candidates (#76) — things git ignores, in other words **things that will be missing from
   * the new worktree.**
   *
   * The list is offered, but the app does not pick for the person: defaulting to "copy everything
   * ignored" would drag in 637MB of node_modules plus an 8.5GB Rust target in this repository alone.
   * The size is shown alongside instead — the judgment a person actually makes from this list is
   * "this one is too big." It is only asked for once the worktree option is turned on (no need to
   * run `du` for a list that will not be used).
   */
  /**
   * Where it branches off from (user finding, 2026-09-07: "when creating a worker, there is no way
   * to choose which branch to fork from").
   *
   * The default is the project's trunk (as set by the manager), or the current branch if there is
   * none — in other words, **something that used to happen silently, now written out in words.**
   * The list only assists, so being unable to read it does not block creation (the same rule as the
   * manager dialog).
   */
  const trunk = project?.worktreeManager?.baseBranch || project?.git?.branch || ''
  /**
   * null = untouched so far → the field shows the trunk. An empty string is **something the person
   * cleared** and is handled differently (left to the host's own order in that case). Initializing
   * the state to the trunk would leave the field frozen empty in a repository where git information
   * arrives late.
   */
  const [base, setBase] = useState<string | null>(null)
  const baseValue = base ?? trunk
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  useEffect(() => {
    if (!isRepo || !worktree || branches) return
    let alive = true
    void platform.git
      .branches(projectId)
      .then((list) => alive && setBranches(list.filter((b) => !b.remote)))
      .catch(() => alive && setBranches([]))
    return () => {
      alive = false
    }
  }, [isRepo, worktree, branches, platform, projectId])

  const [ignored, setIgnored] = useState<{ path: string; bytes: number | null }[] | null>(null)
  useEffect(() => {
    if (!isRepo || !worktree || ignored) return
    let alive = true
    void platform.git
      .ignoredEntries(projectId)
      .then((list) => alive && setIgnored(list))
      .catch(() => alive && setIgnored([]))
    return () => {
      alive = false
    }
  }, [isRepo, worktree, ignored, platform, projectId])

  // The past session to resume. null means 'new session' (the default)
  const [resume, setResume] = useState<ExternalSession | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusSession = useStore((s) => s.focusSession)
  const [past, setPast] = useState<PastState>({ status: 'loading' })

  /**
   * Follows the row picked by the arrow keys when it is outside the collapsed list's view —
   * **only when the selection changes.**
   *
   * This used to be called from the row's own `ref` callback. An inline ref's function identity is
   * different on every render, so React detaches and reattaches it, which meant scrollIntoView ran
   * **on every render.** This dialog subscribes to the store (the project, the session list), so
   * even with just one session running, it re-renders on every event, and each time the list got
   * yanked back to the selected row — this is what "the scroll position snaps back to the top after
   * a moment" was, once the dialog grew from turning the worktree option on (dogfooding, 2026-09-07;
   * measured: one event took the outer value from 324 to 13, the inner one from 1140 to 0).
   *
   * `block: 'nearest'` means nothing happens for a row already visible — that is why the screen does
   * not jump while picking with the mouse.
   */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [resume?.externalId])

  // Detected every time the dialog opens — the person may have just installed or logged in
  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }, [platform])
  useEffect(() => {
    void detect()
  }, [detect])

  // Changing the tool changes the list too — the previous selection belonged to a different tool, so it is discarded
  useEffect(() => {
    let alive = true
    setResume(null)
    setPast({ status: 'loading' })
    void platform.agents
      .listExternalSessions(projectId, tool)
      .then((r) => {
        if (!alive) return
        setPast(
          r.supported
            ? { status: 'ok', sessions: r.sessions }
            : { status: 'unsupported', reason: r.reason ?? 'Could not list past conversations' },
        )
      })
      .catch((e: Error) => alive && setPast({ status: 'unsupported', reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, projectId, tool])

  /**
   * The app has to work normally even when only **one** of the two tools is usable (a product
   * rule).
   *
   * If the default tool is unusable but the other one works fine, this **silently switches to it.**
   * Otherwise, a person who only uses Codex would hit a "log in to Claude" wall every time they
   * opened the dialog, needing to log into a tool they never use just to open it — a direct
   * violation of this app's principle ("do not force a workflow on the person").
   *
   * The switch happens **exactly once**, the moment detection results first arrive. Anything the
   * person picks after that is left untouched.
   */
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!tools || autoPicked.current) return
    autoPicked.current = true
    const ok = (t: ToolName) => {
      const d = tools.find((x) => x.name === t)
      return d?.installed === true && d.loggedIn
    }
    setTool((cur) => (ok(cur) ? cur : (tools.find((x) => x.installed && x.loggedIn)?.name ?? cur)))
  }, [tools])

  const info = (t: ToolName) => tools?.find((x) => x.name === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false

  // The weight that copying would drag along — the judgment a person makes from this list is "this is too big," so a total is shown
  const picks = splitList(copyFiles)
  const pickedBytes = (ignored ?? [])
    .filter((e) => picks.includes(e.path))
    .reduce((n, e) => n + (e.bytes ?? 0), 0)

  return (
    <Modal onClose={onClose} testId="new-session-dialog" align="top">
      <form
        className="flex max-h-[calc(82vh/var(--text-zoom))] w-[480px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') return onClose()
          /*
           * The list is this dialog's body, so the arrow keys pick within it — resuming has to be
           * completable without a mouse, as ⌘N → ↓↓ → ↵. An already-open conversation is skipped
           * over: clicking that row means "jump to it and close," and the dialog must not close
           * while just passing over it with the arrow keys.
           */
          /*
           * **An arrow key inside an input field belongs to that field** (#181). While this handler,
           * attached to the whole form, was not checking the target, a ↓ pressed in the Branch
           * field to move the cursor silently picked a past conversation instead (the button changed
           * from Start to Load), and the Enter pressed right after resumed that conversation instead
           * of starting a new one. The From field's suggestion list (datalist) also failed to open
           * on ↓.
           */
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
            /*
             * The provisioning setting is saved **before** creation (#69) — the host reads and runs
             * the saved setting while creating the worktree, so if the order were reversed, the
             * setup just typed would not apply to this creation. The round trip only happens when
             * it actually changed.
             */
            if (worktree && setupOpen) {
              const next = { command: setupCommand.trim(), copyFiles: splitList(copyFiles) }
              const changed =
                next.command !== (savedSetup?.command ?? '') ||
                next.copyFiles.join('\n') !== (savedSetup?.copyFiles ?? []).join('\n')
              if (changed)
                await saveWorktreeSetup(projectId, next.command || next.copyFiles.length ? next : null)
            }
            await createSession(projectId, {
              tool,
              // If a past session was picked, the tool is asked to resume that conversation (resume),
              // and the past conversation is also restored on screen (importHistory).
              resumeExternalId: resume?.externalId,
              importHistory: resume ? true : undefined,
              worktree: worktree || undefined,
              worktreeBranch: (worktree && branch.trim()) || undefined,
              // Sent exactly as written on screen — only when empty is it left to the host's own order (trunk → HEAD)
              worktreeBase: (worktree && baseValue.trim()) || undefined,
            })
            onClose()
          } catch (err) {
            // A toast disappears after 2.5 seconds and would look like "nothing happened when pressed" — kept inside the modal instead
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {/*
          The header stays fixed and only the body scrolls (the same frame as Settings and Inbox) —
          this is exactly where turning on the worktree option used to add fields and suggestion
          chips and grow the dialog off screen. The start button is pinned at the bottom, so it stays
          within reach no matter how far the scroll has gone.
        */}
        <header className="shrink-0 border-b border-edge px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-chalk">
            New session <span className="text-slate">·</span>{' '}
            <span className="text-ash">{project?.name}</span>
          </h2>
          {/* The tool — two buttons need no subheading to make their meaning clear. Model and permissions are set from the header after creation */}
          <div className="mt-2.5 flex gap-1.5">
            {allTools.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => setTool(t.name)}
                data-testid={`tool-option-${t.name}`}
                title={info(t.name)?.detail}
                className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                  tool === t.name
                    ? 'border-ash bg-graphite/40 text-chalk'
                    : 'border-edge text-ash hover:border-graphite hover:text-chalk'
                } ${tools && !usable(t.name) ? 'opacity-50' : ''}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* The reason it cannot be used is not hidden — a disabled button alone would look like it just does nothing */}
          {blocked && (
            <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="tool-blocked">
              {info(tool)?.installed
                ? `${toolMeta.label} needs a login — run ${toolMeta.login} in a terminal`
                : `${toolMeta.label} not found (${info(tool)?.detail ?? 'not installed'})`}
            </p>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/*
          This dialog's body. Being able to carry a conversation over exactly as it was in the
          terminal is what keeps this app from becoming 'just another window.'
        */}
          <div
            ref={listRef}
            className="max-h-64 overflow-y-auto rounded border border-edge bg-panel"
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
              <p className="px-2.5 py-2 text-[11px] text-slate" data-testid="past-loading">
                Looking for past conversations…
              </p>
            )}
            {/* Using an older tool version does not block a new session too — only the reason is quietly stated */}
            {past.status === 'unsupported' && (
              <p
                className="px-2.5 py-2 text-[11px] leading-relaxed text-slate"
                data-testid="past-unsupported"
              >
                Could not load past conversations — {past.reason}
              </p>
            )}
            {past.status === 'ok' && past.sessions.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-slate" data-testid="past-empty">
                No past conversations in this folder.
              </p>
            )}
            {past.status === 'ok' &&
              past.sessions.map((s) => (
                <PastRow
                  key={s.externalId}
                  selected={resume?.externalId === s.externalId}
                  onSelect={() => {
                    // Does not create another one if it is already open — jumps to that session instead.
                    // Marking it visually without blocking the click used to let the same conversation end up twice in the list (measured).
                    if (s.importedAs) {
                      focusSession(s.importedAs)
                      onClose()
                      return
                    }
                    setResume(s)
                  }}
                  testId={`past-${s.externalId}`}
                  title={s.title}
                  /*
                  The title comes from the tool, and it means something different per tool:
                    Claude — a summary (represents the whole conversation)
                    Codex  — **the first user message** (even a conversation carried on for days
                             shows as its very first topic)
                  So "how recently it was last continued" is stated plainly next to the title —
                  otherwise a recent conversation looks old and cannot be found (a dogfooding
                  finding).
                */
                  meta={[
                    `last ${ago(s.updatedAt)}`,
                    s.branch,
                    s.importedAs ? 'Already open · click to jump' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
          </div>

          {/*
          The warning and its solution are placed in the same spot — the solution to "editing the
          same files can lose changes" is a worktree. The checkbox is only drawn for a repository:
          explaining an option that cannot even be used is noise for the task of creating a session.
        */}
          {running.length > 0 && (
            <p className="mt-2.5 text-[11px] leading-relaxed text-ash" data-testid="concurrent-warning">
              {running.length} sessions are already running in this directory. Editing the same files can lose
              changes.
            </p>
          )}
          {isRepo && (
            <label
              className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11px] text-ash hover:text-chalk"
              data-testid="worktree-toggle"
            >
              <input
                type="checkbox"
                className="accent-ash"
                checked={worktree}
                onChange={(e) => setWorktree(e.target.checked)}
              />
              <span>
                Run in a git worktree
                <span className="text-slate"> — own branch and directory, can’t touch the others’ files</span>
              </span>
            </label>
          )}
          {/*
          Details are only asked for once it is turned on, and when they are, they are grouped
          **into one block** (the same shape as the worktree field in the delete confirmation
          dialog) — stacking full-width input fields plainly would leave it unclear to the eye
          whether they belong to the checkbox or to the dialog as a whole. Since the name becomes
          both the session name and the directory name (effectively permanent), before creation is
          the one and only moment to set it.
        */}
          {isRepo && worktree && (
            <div
              className="mt-2 space-y-2.5 rounded border border-edge bg-panel p-2.5"
              data-testid="worktree-options"
            >
              {/*
                States what an empty field results in (dogfooding, 2026-09-07: "if I don't enter a
                name, what does the branch get called?"). "blank = auto" only states the fact that
                it is automatic, not what it becomes — the name the host derives is
                `centralu/<first 8 chars of the session id>` (manager.ts).
              */}
              <Field label="Branch" hint="blank = centralu/<session id>">
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/…"
                  data-testid="worktree-branch-input"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              {/* **Where** the new branch forks from — a fact that used to live nowhere on screen */}
              <Field label="From" hint="the new branch forks from here">
                <input
                  type="text"
                  value={baseValue}
                  onChange={(e) => setBase(e.target.value)}
                  list="worktree-base-options"
                  placeholder={trunk || 'current branch'}
                  data-testid="worktree-base-input"
                  spellCheck={false}
                  className={inputClass}
                />
                <datalist id="worktree-base-options">
                  {(branches ?? []).map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
              </Field>
              {/*
              Provisioning (#69) — a new worktree is an empty workbench (only tracked files exist:
              no node_modules, no gitignored .env). What is written here runs automatically at
              creation time: copy, then setup. When it is saved, it collapses to a one-line summary —
              always expanding it would make it a confirmation with nothing to confirm.
            */}
              {setupOpen ? (
                <div className="space-y-2.5" data-testid="worktree-setup-edit">
                  <Field label="Setup command" hint="runs once, in the new worktree">
                    <input
                      type="text"
                      value={setupCommand}
                      onChange={(e) => setSetupCommand(e.target.value)}
                      placeholder="pnpm install"
                      data-testid="worktree-setup-command"
                      spellCheck={false}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Copy from the project" hint="comma-separated">
                    <input
                      type="text"
                      value={copyFiles}
                      onChange={(e) => setCopyFiles(e.target.value)}
                      placeholder=".env.local"
                      data-testid="worktree-copy-files"
                      spellCheck={false}
                      className={inputClass}
                    />
                    {/*
                    Candidates are only **pointed at** (#76). Pressing one adds it to the field
                    above, pressing again removes it — the field remains the single source of truth,
                    so something typed by hand and something added by pressing a chip are not
                    distinguished from each other.
                  */}
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
                                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                                    picked
                                      ? 'border-ash bg-graphite/40 text-chalk'
                                      : 'border-edge text-slate hover:border-graphite hover:text-ash'
                                  }`}
                                >
                                  {e.path}
                                  {e.bytes !== null && (
                                    <span className="ml-1 text-slate">{fmtBytes(e.bytes)}</span>
                                  )}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                        {/*
                        States the **total** of what is picked. Even with a size attached to every
                        chip, a person does not add them up mentally — in a repository where the
                        Rust target alone adds 8.5GB, without a total the weight would only be known
                        after the worktree is already created.
                      */}
                        {picks.length > 0 && (
                          <p className="mt-1.5 text-[10px] text-slate" data-testid="copy-total">
                            {picks.length} to copy{pickedBytes > 0 ? ` · ~${fmtBytes(pickedBytes)}` : ''}
                            {pickedBytes > 1024 ** 3 && (
                              <span className="text-ash"> — every worktree pays this again</span>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </Field>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="worktree-setup-summary"
                  onClick={() => setSetupOpen(true)}
                  className="block w-full truncate rounded border border-edge px-2 py-1 text-left font-mono text-[10px] text-slate hover:border-graphite hover:text-ash"
                  title="Edit worktree setup"
                >
                  {savedSetup?.command ? `setup: ${savedSetup.command}` : 'setup: (none)'}
                  {savedSetup?.copyFiles.length ? ` · copies: ${savedSetup.copyFiles.join(', ')}` : ''}
                </button>
              )}
            </div>
          )}

          {error && (
            <p
              className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
              data-testid="create-session-error"
            >
              {error}
            </p>
          )}
        </div>

        {/*
          The shortcut hint was removed (dogfooding, 2026-09-02) — ↑↓, ↵ and esc are things the hand
          already knows in any dialog with a list, and the value is too small for a spot that gets
          read every time. The behavior is unchanged: only the hint text is gone.
        */}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-edge px-4 py-2.5">
          <button
            type="button"
            className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            /* Since the input field is gone, Enter means start — this needs to hold the default focus */
            autoFocus
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || blocked}
            data-testid="create-session-confirm"
          >
            {busy ? (resume ? 'Loading…' : 'Starting…') : resume ? 'Load' : 'Start'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

/**
 * A label plus a field.
 *
 * A long instruction that used to live in the placeholder was moved up into the label — a
 * placeholder **disappears the moment typing starts**, so it is gone exactly when the person needs
 * to ask again "what was I supposed to put here." On top of that, in a 480px dialog, "Setup command,
 * runs once in the new worktree (e.g. pnpm install)" got truncated and could not even be read in
 * full.
 *
 * Why a div instead of a label: a suggestion chip (a button) sits inside it, and a click inside a
 * label passes through to the field — the input field grabbing focus every time a chip is pressed
 * would get in the way of picking one.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] text-ash">
        {label}
        {hint && <span className="text-slate"> · {hint}</span>}
      </p>
      {children}
    </div>
  )
}

/**
 * One list row. Selection is stated by brightness alone (the grayscale rule) — drawing a checkbox
 * would make it look like a setting, and picking is what this actually does.
 */
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
  meta: string
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
          ? 'border-l-ash bg-graphite/40 text-chalk'
          : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
      }`}
    >
      <span className="truncate text-[12px] leading-snug">{title}</span>
      {meta && <span className="readout truncate text-[10px] text-slate">{meta}</span>}
    </button>
  )
}
