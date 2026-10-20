import { TrustProjectButton } from './TrustCard.jsx'
import { useEffect, useState } from 'react'
import { newAppIdProblem } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { isPlainEscape } from '../../app/keys.js'
import { Modal } from '../../components/Modal.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { Button } from '../../components/Button.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { TextField, TextInput } from '../../components/TextField.jsx'
import { useTools } from '../../store/selectors.js'
import { useStore } from '../../store/store.js'
import { appIdHint, deriveAppId } from './newAppId.js'
import { useToolChoice } from './useToolChoice.js'

/**
 * New app (M4 C-1) — asks for a name and the agent that builds it, and the host unpacks the app
 * from a template and starts that app's builder session.
 *
 * Two things are asked for. **The name** (what the person calls it) and **who builds it** (the
 * builder session's tool). The id is derived from the name, shown, and left editable — since it is
 * both a folder name and a session's server name, it has rules (newAppId.ts), and the validation is
 * the same one the host uses (`newAppIdProblem`). All this dialog blocks up front is the shape: an
 * id that already exists, trust, and the template are judged by the host, and if it rejects it, that
 * wording is shown **exactly as-is.** If the dialog rewrote the host's wording in its own words, the
 * day the two drift apart the person would read the wrong reason.
 *
 * The tool follows the same rule as the new session dialog: detected again every time it opens (the
 * person may have just logged in), switched once to whichever is usable if the default tool is not,
 * and if an unusable tool is chosen, the reason and the fix command are stated. Nothing is created
 * with an unusable tool — even if the app itself comes to exist, if its builder session cannot start,
 * the person is left facing an app nobody can fix.
 *
 * The host does not create an app in an untrusted project (an app is code that runs on this
 * machine). That fact is stated before the rejection arrives, with a way to trust it right there.
 *
 * Without a project (#1141) the app is a project of its own, made like a new project: a folder named by its id, in
 * `~/Centralu` unless the person picks another parent, with the same preview and refusals as the new project dialog
 * (`projects.createPreview`), so the folder that will be made stands on the form before anything is made. Importing an
 * app lands the same way, so its door is here too.
 */
export function NewAppDialog({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  const platform = usePlatform()
  const openImport = useStore((s) => s.openImport)
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const orchestratorTool = useStore((s) => (s.orchestratorId ? s.sessions[s.orchestratorId]?.tool : undefined))
  const createApp = useStore((s) => s.createApp)
  const allTools = useTools()
  /*
   * The default tool is guessed to match what the host would choose — a project app defaults to
   * that project's default, a user-folder app to the orchestrator's tool. Even when the guess is
   * wrong, the dialog **always sends the tool actually selected**: a session never starts with a
   * different tool than the one shown selected.
   */
  const { tool, setTool, toolMeta, tools, info, usable, blocked, detectError, redetect } = useToolChoice(
    (projectId ? project?.defaultTool : orchestratorTool) ?? allTools[0]?.name ?? '',
  )
  const [name, setName] = useState('')
  /** The value the person entered if they touched the id, otherwise null — the derived id keeps following as the name is edited */
  const [idEdit, setIdEdit] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const id = idEdit ?? deriveAppId(name)
  const problem = newAppIdProblem(id)
  const untrusted = !!project && !project.trusted
  // Without a project: where its folder goes. Null is ~/Centralu; a typed parent is sent as typed, the host judges it
  const [parent, setParent] = useState<string | null>(null)
  const [where, setWhere] = useState<{ parent: string; path: string | null; error: string | null; asked: string } | null>(null)
  // What the preview was asked for: an answer for older input does not count, so Enter in the pause before it lands waits
  const asked = `${problem === null ? id : ''}
${parent?.trim() ?? ''}`
  useEffect(() => {
    if (projectId) return
    let live = true
    // Asked after a pause in typing, as the new project dialog does
    const t = setTimeout(() => {
      platform.projects
        .createPreview(problem === null ? id : '', parent?.trim() || undefined, null)
        .then((p) => live && setWhere({ ...p, asked }))
        .catch((e: Error) => live && setWhere({ parent: parent ?? '', path: null, error: e.message, asked }))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [platform, projectId, id, problem, parent, asked])
  const placed = projectId !== null || (where?.asked === asked && !!where.path && !where.error)

  const canCreate = !busy && name.trim() !== '' && problem === null && !blocked && !untrusted && tool !== '' && placed

  return (
    <Modal onClose={onClose} testId="new-app-dialog" align="top">
      <form
        className="flex w-[440px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
        onKeyDown={(e) => {
          // Not the Esc that cancels a composition in the name field (#181)
          if (isPlainEscape(e.nativeEvent)) onClose()
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!canCreate) return
          setBusy(true)
          setError(null)
          try {
            await createApp({ projectId, id, name: name.trim(), tool, ...(projectId === null && parent?.trim() ? { parent: parent.trim() } : {}) })
            onClose()
          } catch (err) {
            // Exactly the host's own wording — a toast disappears after 2.5 seconds and would look like "nothing happened when pressed." Kept inside the dialog instead
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <header className="shrink-0 border-b border-line px-4 py-2.5">
          <h2 className="text-md font-medium text-ink">
            New app
            {project && (
              <>
                {' '}
                <span className="text-ink-faint">·</span> <span className="text-ink-muted">{project.name}</span>
              </>
            )}
          </h2>
          <p className="mt-1 text-xs leading-body text-ink-faint">
            {projectId
              ? 'Lives in this project, in .centralu/apps, and is shared with the repository.'
              : 'A project of its own, in a new folder. The orchestrator and your other projects can use it.'}
          </p>
        </header>

        <div className="space-y-3 px-4 py-3">
          <TextField
            label="Name"
            text="sm"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Resource search"
            maxLength={80}
            spellCheck={false}
            data-testid="new-app-name"
          />
          <TextField
            label="Id"
            hint={`folder name, and how agents see it (app-${id || '…'})`}
            font="mono"
            value={id}
            onChange={(e) => setIdEdit(e.target.value)}
            placeholder="resource-search"
            spellCheck={false}
            data-testid="new-app-id"
            aria-invalid={problem !== null || undefined}
            error={problem !== null && (name.trim() !== '' || idEdit !== null) ? appIdHint(id, problem) : undefined}
            errorTestId="new-app-id-problem"
          />

          <div>
            <p className="mb-1 text-2xs text-ink-muted">Built by</p>
            <Segmented
              label="Built by"
              value={tool}
              onChange={setTool}
              options={allTools.map((t) => ({
                value: t.name,
                label: t.label,
                testId: `new-app-tool-${t.name}`,
                title: info(t.name)?.detail,
                dim: !!tools && !usable(t.name),
              }))}
            />
            {/* The reason it cannot be used is not hidden — a disabled button alone would look like it just does nothing */}
            {blocked && (
              <p className="mt-1.5 text-xs leading-body text-ink-muted" data-testid="new-app-tool-blocked">
                {info(tool)?.installed
                  ? `${toolMeta.label} needs a login. Run ${toolMeta.login} in a terminal, then open this again.`
                  : `${toolMeta.label} is not installed (${info(tool)?.detail ?? 'not found'}).`}
              </p>
            )}
            {detectError && (
              <LoadFailed what="which tools are installed" error={detectError} onRetry={() => void redetect()} className="mt-1.5" testId="new-app-tool-detect-failed" />
            )}
            {!blocked && (
              <p className="mt-1.5 text-xs leading-body text-ink-faint">
                A builder session with {toolMeta.label} starts with the app. Ask it for changes while you use the app.
              </p>
            )}
          </div>

          {projectId === null && (
            <div className="text-xs leading-body text-ink-muted" data-testid="new-app-location">
              {parent === null ? (
                // Change sits at the row's end, as in the new project dialog: the location arrives a moment after the dialog opens
                <p className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1">
                    In <span className="readout break-all text-ink" data-testid="new-app-parent-shown">{where?.parent ?? '…'}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0"
                    onClick={() => setParent(where?.parent ?? '')}
                    data-testid="new-app-change-parent"
                    aria-label="Change the folder its folder goes in"
                  >
                    Change
                  </Button>
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <TextInput
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                    placeholder="The full path of a folder"
                    aria-label="The folder its folder goes in"
                    font="mono"
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="new-app-parent"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="quiet"
                    size="sm"
                    className="shrink-0"
                    onClick={async () => {
                      try {
                        const picked = await platform.system.pickDirectory()
                        if (picked) setParent(picked)
                      } catch (e) {
                        // A picker the shell refused is said in the form, not dropped as an unhandled rejection (#972)
                        setError((e as Error).message)
                      }
                    }}
                    data-testid="new-app-pick-parent"
                  >
                    Choose…
                  </Button>
                </div>
              )}
              {where?.path && !where.error && (
                <p className="mt-1 text-ink-faint">
                  Its folder will be{' '}
                  <span className="readout break-all text-ink-muted" data-testid="new-app-path">
                    {where.path}
                  </span>
                </p>
              )}
              {where?.error && problem === null && id !== '' && (
                <p className="mt-1 text-danger" role="alert" data-testid="new-app-location-error">
                  {where.error}
                </p>
              )}
            </div>
          )}

          {untrusted && project && (
            <div className="rounded-md border border-line bg-surface-raised px-2.5 py-2" data-testid="new-app-untrusted">
              <p className="text-xs leading-body text-ink-muted">
                Apps only run in projects you trust. Trust {project.name} to make an app here.
              </p>
              {/* The same card as the project's row, with its apps listed (#1141) */}
              <TrustProjectButton projectId={project.id} testId="new-app-trust" className="mt-1.5" />
            </div>
          )}

          {error && (
            <p
              className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
              role="alert"
              data-testid="new-app-error"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          {/* An import lands as a project of its own too (#1141), so its door stands where a new app is made */}
          {projectId === null && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onClose()
                openImport()
              }}
              data-testid="new-app-import"
            >
              Import one…
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canCreate} busy={busy} busyText="Creating…" data-testid="new-app-create">
            Create
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
