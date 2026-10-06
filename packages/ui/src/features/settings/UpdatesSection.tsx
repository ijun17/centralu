import { useEffect } from 'react'
import { APP_VERSION } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { applyOffer, updateStateText, useRelaunchCheck } from './apply-update.js'

/**
 * Updates (issue #43).
 *
 * This screen says three sentences: this is what is currently running, that is what is out
 * there, and whether to upgrade is for the person to decide. **It never upgrades on its own
 * unless asked to in advance** ("Apply updates automatically when idle", #352, off by default) —
 * swapping out the running app is not reversible, and this app does not do irreversible things
 * quietly. Even then it waits until nothing is running and nobody is typing.
 *
 * The check is done by the host. The launcher has the same code too, but what actually runs is
 * a copy already installed on the person's machine, and that copy's comparison logic was wrong
 * (#42) — checking here runs the code shipped with the app itself, bypassing the stale launcher
 * entirely.
 */
export function UpdatesSection() {
  const update = useStore((s) => s.update)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const setUpdateAuto = useStore((s) => s.setUpdateAuto)
  const setUpdateAutoApply = useStore((s) => s.setUpdateAutoApply)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const applyUpdateNow = useStore((s) => s.applyUpdateNow)
  const relaunch = useRelaunchCheck()
  const offer = update?.phase === 'restart_required' ? applyOffer(update, APP_VERSION, relaunch) : null

  /*
   * Even before the host has answered, **the current version can already be stated.**
   *
   * It is the same constant from the same build (`tooling/brand.test.ts` keeps it identical
   * everywhere), so there is no room for it to drift, and that is why this branch is never empty
   * from the moment it opens — if one side of the comparison is invisible, the rest of the line
   * cannot be read either.
   */
  const current = update?.current ?? APP_VERSION
  const busy = update?.phase === 'checking' || update?.phase === 'updating'

  return (
    <section>
      <p className="text-xs leading-body text-ink-faint">
        Centralu updates through npm, the same way it was installed. Checking only asks the
        registry which version is newest; installing happens when you ask for it. Applying it
        relaunches the window, and running agents, terminals and commands keep going.
      </p>

      <p className="mt-3 text-sm text-ink-muted" data-testid="update-current">
        Running {current}
      </p>
      <p className="mt-1 text-sm text-ink-faint" data-testid="update-state">
        {updateStateText(update, offer)}
      </p>

      <div className="mt-2 flex items-center gap-3">
        <button
          className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink disabled:opacity-50"
          data-testid="update-check-now"
          disabled={busy}
          onClick={() => void checkUpdate(true)}
        >
          Check now
        </button>
        {update?.newer && update.latest && update.phase !== 'restart_required' && (
          <button
            className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-hover/50 disabled:opacity-50"
            data-testid="update-apply"
            disabled={busy}
            onClick={() => void applyUpdate()}
          >
            Update to {update.latest}
          </button>
        )}
        {offer?.kind === 'apply' && (
          <button
            className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors hover:bg-surface-hover/50"
            data-testid="update-apply-now-settings"
            onClick={() => void applyUpdateNow()}
          >
            Apply now
          </button>
        )}
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="accent-line-strong"
          data-testid="update-auto"
          checked={update?.auto ?? true}
          onChange={(e) => void setUpdateAuto(e.target.checked)}
        />
        Check for updates automatically
      </label>
      {/*
        Why leaving this on is the default is recorded here. Someone turning it off needs to
        know what they are turning off, and someone leaving it on needs to know what goes out —
        there is no request that goes out silently.
      */}
      <p className="mt-1 text-xs leading-body text-ink-faint">
        Once at startup and every six hours while the app is open. It asks the public npm
        registry for one version number and nothing else; if it cannot reach it, nothing
        happens and nothing interrupts you.
      </p>

      {/*
        Only where the window can apply an update without cutting anything (#352: the desktop app
        with the keeper). Elsewhere a box that installs and then waits for a restart nobody does
        would only leave a stale window behind.
      */}
      {relaunch !== undefined && (
        <>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              className="accent-line-strong"
              data-testid="update-auto-apply"
              checked={update?.autoApply ?? false}
              onChange={(e) => void setUpdateAutoApply(e.target.checked)}
            />
            Apply updates automatically when idle
          </label>
          <p className="mt-1 text-xs leading-body text-ink-faint">
            A newer version is installed as soon as it is found, and applied once no session is
            working or waiting for you, no terminal or command is running, and you are not typing.
            Applying relaunches the window; agents keep running through it.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * The agent CLIs (#297): which versions are installed, and whether idle sessions move to a newer one by themselves.
 *
 * Next to the app's own update because it is the same errand — "am I on the new version" — for the other programs
 * this app runs. Unlike the app's update this one is **on by default** (the owner's decision, 2026-10-05): nothing is
 * installed here, the CLIs update themselves or through npm, and moving a session waits until nothing in it would be
 * lost. Its conversation continues, and a line in it says that it moved.
 */
export function AgentCliUpdates() {
  const versions = useStore((s) => s.agentVersions)
  const tools = useStore((s) => s.tools)
  const setAutoApply = useStore((s) => s.setAgentAutoApply)
  const check = useStore((s) => s.checkAgentVersions)
  useEffect(() => {
    void check(false)
  }, [check])
  const installed = Object.entries(versions?.installed ?? {})
    .filter(([, v]) => v)
    .map(([tool, v]) => `${tools.find((t) => t.name === tool)?.label ?? tool} ${v}`)
  return (
    <section className="mt-5 border-t border-line pt-4" data-testid="settings-agent-versions">
      <p className="text-sm text-ink-muted" data-testid="agent-versions-installed">
        {versions === null ? 'Agent CLIs: not checked yet' : installed.length > 0 ? `Installed: ${installed.join(' · ')}` : 'No agent CLI version found'}
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="accent-line-strong"
          data-testid="agent-versions-auto-apply"
          checked={versions?.autoApply ?? true}
          disabled={versions === null}
          onChange={(e) => void setAutoApply(e.target.checked)}
        />
        Move idle sessions to a newly installed agent CLI
      </label>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        Each session runs its own Claude Code or Codex process, which keeps the version it started with. With this on, a
        session restarts on the newer one once it is not working, not waiting for you and not running background tasks.
        The conversation continues, and a line in it says the session moved.
      </p>
    </section>
  )
}
