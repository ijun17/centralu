import { forgetArrivalsOf } from './apps.js'
import type { ProjectInfo } from '@cc/protocol'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { forgetSessions } from './sessionList.js'
import { inOrder, omitKey, stillInOrder } from './patch.js'

/**
 * Projects in the store: the list and its reads, which leave alone a project this window is writing
 * (`writingProject`), adding and making one, trust, deletion, the git summary and its writes, the
 * worktree setup and the saved commands. `projectActions` holds the store's actions for them.
 */

/** What a project carries that any client may change through the host (#719); `git` and the identity stay as the window has them */
const PROJECT_SETTING_KEYS = ['trusted', 'commands', 'worktreeSetup', 'worktreeManager', 'defaultTool', 'defaultModels'] as const satisfies readonly (keyof ProjectInfo)[]

/*
 * The writes this window has made to a project and not seen settle (#719). A list read that began before a write
 * finished may carry the value from before it, and taking that over the window's own newer value would hide a command
 * just added: the next whole-list save would then drop it on the host. So a read leaves a project alone while a write
 * of its own is in flight or finished after the read began, and reads it again once the write is done.
 */
const projectWrites = { clock: 0, flying: new Map<string, number>(), last: new Map<string, number>(), held: new Set<string>() }

export async function writingProject<T>(projectId: string, refresh: () => void, run: () => Promise<T>): Promise<T> {
  const w = projectWrites
  w.flying.set(projectId, (w.flying.get(projectId) ?? 0) + 1)
  w.last.set(projectId, ++w.clock)
  try {
    return await run()
  } finally {
    const left = (w.flying.get(projectId) ?? 1) - 1
    if (left) w.flying.set(projectId, left)
    else w.flying.delete(projectId)
    w.last.set(projectId, ++w.clock)
    // A read withheld this project's value meanwhile: the host's value, with this write in it, is read now
    if (!left && w.held.delete(projectId)) refresh()
  }
}

/**
 * One read of the project list, taken over the rows already listed. New projects join at the end; a listed row keeps
 * its place and takes the host's value of the settings another client can change (trust, commands, worktree setup,
 * defaults: #719) and keeps its object when none of them differs. `git` is left alone: it has its own refresh, and a
 * list read does not carry the freshest count. A project this window is writing is left as it is (`projectWrites`).
 * @returns whether a project had to be skipped after its write was already done, so one more read is due
 */
async function readProjects(platform: NonNullable<AppState['platform']>, set: StoreSet): Promise<boolean> {
  const began = projectWrites.clock
  const list = await platform.projects.list().catch(() => null)
  if (!list) return false
  let again = false
  set((s) => {
    const next = { ...s.projects }
    let changed = false
    for (const p of list) {
      const cur = s.projects[p.id]
      if (!cur) {
        next[p.id] = p
        changed = true
      } else if (PROJECT_SETTING_KEYS.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(p[k]))) {
        if (projectWrites.flying.has(p.id)) projectWrites.held.add(p.id)
        else if ((projectWrites.last.get(p.id) ?? 0) > began) again = true
        else {
          next[p.id] = { ...cur, ...Object.fromEntries(PROJECT_SETTING_KEYS.map((k) => [k, p[k]])) }
          changed = true
        }
      }
    }
    return changed ? { projects: next } : {}
  })
  return again
}

/** The one project list read at a time: a second ask waits for the first and reads once more, so reads never land out of order */
let projectsReading: { platform: unknown; done: Promise<void>; again: boolean } | null = null

/**
 * A project the person registered from this window (adding a folder, or making one, #515) joins the list, and is asked
 * about once for trust — unless it is already trusted (the same folder chosen again).
 */
function joinProject(s: Pick<AppState, 'projects' | 'trustAsk'>, p: ProjectInfo): Pick<AppState, 'projects' | 'trustAsk'> {
  return { projects: { ...s.projects, [p.id]: p }, trustAsk: p.trusted ? s.trustAsk : p.id }
}

/**
 * How long a project's git refresh waits for the next trigger before it runs (issue #41).
 *
 * The triggers arrive in bursts, not singly: three sessions in one project finishing
 * seconds apart, an approval granted and the turn it unblocked ending right after, a
 * focus and a visibilitychange for one alt-tab. Each of those would otherwise be its own
 * `git status` over the same working tree. One trailing window per project collapses a
 * burst into one measurement, and it has to be short enough that the number has already
 * moved by the time the eye goes looking for it — 800ms is under the glance.
 *
 * The delay also puts the measurement *after* the write it was told about, which matters
 * for the approval trigger: the edit lands in the moment following the "allow", not in it.
 */
const GIT_REFRESH_MS = 800

/**
 * Pending git refreshes, one timer per project — module scope for the same reason
 * `subscriptions` is: nothing on screen reads a timer, so keeping it out of the store
 * costs no renders.
 */
const gitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Whether two git summaries say the same thing — a refresh that found nothing must not redraw */
function sameGit(a: ProjectInfo['git'], b: ProjectInfo['git']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.branch === b.branch &&
    a.changedFiles === b.changedFiles &&
    a.isRepo === b.isRepo &&
    a.denied === b.denied &&
    a.more === b.more &&
    a.unknown === b.unknown
  )
}

/** The store's actions for projects */
type ProjectActions = Pick<
  AppState,
  | 'setWorktreeTrunk'
  | 'addProject'
  | 'createProject'
  | 'refreshProjects'
  | 'answerTrustAsk'
  | 'askTrust'
  | 'setProjectTrusted'
  | 'deleteProject'
  | 'refreshProjectGit'
  | 'gitStage'
  | 'gitCommit'
  | 'gitCheckout'
  | 'saveWorktreeSetup'
  | 'setProjectCommands'
  | 'loadCommandRuns'
  | 'runCommand'
  | 'stopCommand'
  | 'watchProjectDirs'
  | 'reorderProjects'
>

/** Projects whose last watch registration failed and was said: said again only after one succeeds (#841) */
const watchFailureSaid = new Set<string>()

export const projectActions = (set: StoreSet, get: StoreGet): ProjectActions => ({
  async setWorktreeTrunk(projectId, baseBranch) {
    const platform = get().platform
    if (!platform) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      try {
        await platform.projects.setWorktreeTrunk(projectId, baseBranch)
      } catch (e) {
        // Returned to the dialog, which keeps the typed branch and the reason in place (#180)
        throw new Error(`Could not set the trunk: ${(e as Error).message}`)
      }
      set((s) => {
        const p = s.projects[projectId]
        return p
          ? { projects: { ...s.projects, [projectId]: { ...p, worktreeManager: { sessionId: p.worktreeManager?.sessionId ?? '', baseBranch } } } }
          : {}
      })
    })
  },

  async addProject(path, machine) {
    const p = await get().platform!.projects.add(path, machine)
    set((s) => joinProject(s, p))
    return p
  },

  async createProject(name, parent, machine, source) {
    const p = await get().platform!.projects.create(name, parent, machine, source)
    set((s) => joinProject(s, p))
    return p
  },

  refreshProjects() {
    const platform = get().platform
    if (!platform) return Promise.resolve()
    const running = projectsReading
    if (running && running.platform === platform) {
      running.again = true
      return running.done
    }
    const mine: NonNullable<typeof projectsReading> = { platform, again: false, done: Promise.resolve() }
    mine.done = (async () => {
      try {
        do {
          mine.again = false
          if (await readProjects(platform, set)) mine.again = true
        } while (mine.again)
      } finally {
        if (projectsReading === mine) projectsReading = null
      }
    })()
    projectsReading = mine
    return mine.done
  },

  askTrust(projectId) {
    if (get().projects[projectId]) set({ trustAsk: projectId })
  },

  async answerTrustAsk(trust) {
    const id = get().trustAsk
    if (!id) return
    set({ trustAsk: null })
    if (trust) await get().setProjectTrusted(id, true)
  },

  async setProjectTrusted(projectId, trusted) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      try {
        await platform.projects.setTrusted(projectId, trusted)
        set((s) => {
          const p = s.projects[projectId]
          return p ? { projects: { ...s.projects, [projectId]: { ...p, trusted } } } : {}
        })
        /*
         * Trust changed here (#1141): the project is looked at afresh at the next read of the app list, which the host
         * sends for the change. The apps it has then were on its card, so none is news, even ones whose list had not
         * arrived when the person pressed Trust; untrusted, it is no longer watched
         */
        forgetArrivalsOf(get, set, projectId)
        const running = Object.values(get().sessions).some((x) => x.projectId === projectId && x.live)
        if (running) set({ toast: 'Running sessions here pick up the new trust when they restart or resume.' })
      } catch (e) {
        set({ toast: `Could not change trust: ${(e as Error).message}` })
      }
    })
  },

  async deleteProject(projectId, deleteFiles) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    if (deleteFiles) {
      /*
       * The project folder has a door of its own (#838): the file tree's trash refuses the project folder, so a link in
       * a repository (`old-build -> .`) cannot send it there. The host resolves it, so no absolute path is built here.
       * The hand that deletes lives in the shell (Rust), and what that hand does is **move to trash** (the fs port's
       * rule: "Not a delete — that is the whole decision").
       */
      const r = await platform.fs.trashProjectFolder(projectId)
      if (!r.supported) throw new Error(r.reason ?? 'This build cannot delete files')
    }
    await platform.projects.remove(projectId)
    /*
     * Sessions also disappear through the host's own `session_deleted`, but they are cleared here as
     * well: waiting for that event would leave a session row on screen for a project that no longer
     * exists.
     */
    set((s) => {
      const projects = omitKey(s.projects, projectId)
      const doomed = Object.values(s.sessions)
        .filter((x) => x.projectId === projectId)
        .map((x) => x.id)
      const sessions = { ...s.sessions }
      for (const id of doomed) delete sessions[id]
      return {
        projects,
        sessions,
        ...forgetSessions(s, new Set(doomed)),
        /*
         * What was kept per project goes with it. The id can come back (restoring one of its sessions from the trash
         * re-adds the project under its old id), and then it starts the way a newly added project does: the deletion
         * stopped its command runs, and a git epoch of 0 and folded folders are the defaults anyway.
         */
        gitEpoch: omitKey(s.gitEpoch, projectId),
        expandedDirs: omitKey(s.expandedDirs, projectId),
        commandRuns: omitKey(s.commandRuns, projectId),
        focusedProjectId: s.focusedProjectId === projectId ? null : s.focusedProjectId,
        trustAsk: s.trustAsk === projectId ? null : s.trustAsk,
        foldedProjects: s.foldedProjects.filter((id) => id !== projectId),
        projectPanels: Object.fromEntries(Object.entries(s.projectPanels).filter(([id]) => id !== projectId)),
      }
    })
    // The fold and the arrangement just dropped live in the snapshot — write it, or the next launch reads them back
    get().saveWorkspace()
    get().pruneFoldedGroups()
  },

  refreshProjectGit(projectId) {
    const pending = gitRefreshTimers.get(projectId)
    if (pending !== undefined) clearTimeout(pending)
    gitRefreshTimers.set(
      projectId,
      setTimeout(() => {
        gitRefreshTimers.delete(projectId)
        const platform = get().platform
        // The project can be gone by the time the window closes (removed, or a reconnect
        // rebuilt the list). Measuring a folder nobody is showing helps no one.
        if (!platform || !get().projects[projectId]) return
        // Makes the panel's own held list re-read at the same moment too (#160). Bumped even when
        // the summary is unchanged — editing the same file again leaves the change count the same
        // while the content has changed
        set((s) => ({ gitEpoch: { ...s.gitEpoch, [projectId]: (s.gitEpoch[projectId] ?? 0) + 1 } }))
        void platform.projects
          .gitStatus(projectId)
          .then(({ git }) =>
            set((s) => {
              const cur = s.projects[projectId]
              /*
               * Nothing new is not an update. This runs after every turn and every return to
               * the window, and "the count is the same" is the common answer — handing every
               * row a fresh object each time would re-render the whole sidebar to redraw
               * identical text.
               */
              if (!cur || sameGit(cur.git, git)) return {}
              // git did not answer in time: the last count still stands rather than reading as none (#850 review)
              if (git?.unknown && cur.git) return {}
              /*
               * **Only `git` is taken from the answer.** The host rebuilds the rest of
               * ProjectInfo from its own defaults, so swallowing the whole row would let a
               * reply that landed mid-`setProjectCommands` undo the list being edited.
               * This action was asked for one field; it writes one field.
               */
              return { projects: { ...s.projects, [projectId]: { ...cur, git } } }
            }),
          )
          /*
           * Silence on failure, deliberately. This is a number in the margin that nobody
           * asked for — a repo that has just been deleted, or a host that dropped the
           * project, must not put a toast in front of someone who was doing something else.
           * The stale count stays, which is exactly where we were before.
           */
          .catch(() => {})
      }, GIT_REFRESH_MS),
    )
  },

  /*
   * The three writes (issue #49). Each does the thing, then says the tree moved — the
   * `await` matters, because a status read that overtakes its own commit measures the repo
   * as it was and writes that back as news.
   *
   * Staging is in here even though it rarely moves the number (porcelain counts one line per
   * changed path whether it is staged or not). "Rarely" is not "never" — staging a file whose
   * content matches HEAD drops it out of status entirely — and the debounce plus `sameGit`
   * mean an answer identical to the last one costs one call and re-renders nothing. The
   * alternative is a rule about which writes qualify, which is the kind of rule that is
   * silently wrong for a year.
   */
  async gitStage(projectId, paths, unstage) {
    await get().platform!.git.stage(projectId, paths, unstage)
    get().refreshProjectGit(projectId)
  },

  async gitCommit(projectId, message) {
    const res = await get().platform!.git.commit(projectId, message)
    // Refresh even when the commit was refused: git can reject *after* moving something
    // (a hook that stages, a partial index update), and the count must not be left guessing.
    get().refreshProjectGit(projectId)
    return res
  },

  async gitCheckout(projectId, branch) {
    const res = await get().platform!.git.checkout(projectId, branch)
    get().refreshProjectGit(projectId)
    return res
  },

  async saveWorktreeSetup(projectId, setup) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      await platform.projects.setWorktreeSetup(projectId, setup)
      // The summary line must match the next time it opens — follows the host's own normalizing rule (an empty setup means `null`)
      const clean = setup && (setup.command || setup.copyFiles.length) ? setup : null
      set((s) => {
        const now = s.projects[projectId]
        return now ? { projects: { ...s.projects, [projectId]: { ...now, worktreeSetup: clean } } } : {}
      })
    })
  },

  async setProjectCommands(projectId, commands) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      // Draw it first. This is a list being edited by hand, and a row that appears only after
      // a round trip reads as a click that missed.
      set((s) => ({ projects: { ...s.projects, [projectId]: { ...(s.projects[projectId] ?? before), commands } } }))
      try {
        const saved = await platform.projects.setCommands(projectId, commands)
        set((s) => {
          const now = s.projects[projectId]
          // The project could have gone while we were away; nothing to correct if so
          return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: saved } } } : {}
        })
      } catch (e) {
        /*
         * Put the old list back and say so. A command that looks saved and is gone at the
         * next launch is the worse half of this: the menu would then say "nothing saved yet",
         * which reads as never having added it rather than as having lost it.
         */
        set((s) => {
          // Only the list goes back (#842 item 3): a rename made meanwhile stays, and a project removed meanwhile is not revived
          const now = s.projects[projectId]
          return {
            ...(now ? { projects: { ...s.projects, [projectId]: { ...now, commands: before.commands } } } : {}),
            toast: `Could not save commands: ${(e as Error).message}`,
          }
        })
      }
    })
  },

  async loadCommandRuns(projectId) {
    const platform = get().platform
    if (!platform) return
    try {
      const runs = await platform.commands.state(projectId)
      set((s) => {
        const before = s.commandRuns[projectId] ?? {}
        return {
          commandRuns: {
            ...s.commandRuns,
            // What only this window saw of a run (when it ended, that it was stopped) stays with that same run
            [projectId]: Object.fromEntries(
              runs.map((r) => {
                const was = before[r.command]
                return [r.command, was?.runId === r.runId ? { ...was, ...r } : r]
              }),
            ),
          },
        }
      })
    } catch {
      // If it could not be read, it is re-read the next time the panel opens — the badge is just dark for a moment
    }
  },

  async runCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    try {
      // The size is re-measured for real once the log window (`CommandLog`) attaches — this is only a starting value
      const info = await platform.commands.run(projectId, command, 100, 30)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: { ...s.commandRuns[projectId], [command]: info },
        },
      }))
    } catch (e) {
      // No silent failures — believing it started when it did not leaves someone waiting on a log that never comes
      set({ toast: `Could not run: ${(e as Error).message}` })
    }
  },

  async stopCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    /*
     * Marked before asking, so its exit reads as a stop and not as a failure (`CommandRun.stopped`): a dev server ends
     * with whatever code its signal gives it, and "exit 143" drawn as a failure after pressing Stop reads as a crash. Only
     * the run that is running now is marked; a re-run meanwhile is a new record without the mark.
     */
    const mark = (stopped: boolean) =>
      set((s) => {
        const r = s.commandRuns[projectId]?.[command]
        if (!r?.running) return {}
        return {
          commandRuns: {
            ...s.commandRuns,
            [projectId]: { ...s.commandRuns[projectId], [command]: { ...r, stopped } },
          },
        }
      })
    mark(true)
    try {
      await platform.commands.stop(projectId, command)
    } catch (e) {
      // As `runCommand` (#841 item 11): a stop that failed left the badge lit with no word, read as "it is stopping"
      mark(false)
      set({ toast: `Could not stop: ${(e as Error).message}` })
    }
  },

  async watchProjectDirs(projectId, dirs) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.fs.watch(projectId, dirs)
      watchFailureSaid.delete(projectId)
    } catch (e) {
      /*
       * Watching is a side glance, so the tree goes on (#34), but a failure swallowed whole left a tree that stopped
       * following what an agent or Finder changed with no word of it (#841). Said once: the tree asks again with every
       * folder opened
       */
      if (watchFailureSaid.has(projectId)) return
      watchFailureSaid.add(projectId)
      set({ toast: `The file tree will not follow changes made outside it: ${(e as Error).message}` })
    }
  },

  /**
   * Sidebar order.
   *
   * **The screen changes first, and the save follows.** If a dragged item waited for a round trip to
   * the server before moving, the hand would feel like it stumbled. If saving fails, it reverts to
   * whatever the host says is true — it is never left silently out of sync.
   */
  async reorderProjects(orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().projects
    set({ projects: Object.fromEntries(orderedIds.map((id) => [id, before[id]!]).filter(([, v]) => v)) })
    try {
      const fresh = await platform.projects.reorder(orderedIds)
      set({ projects: Object.fromEntries(fresh.map((p) => [p.id, p])) })
    } catch (e) {
      /*
       * The projects as they are now, in the order from before the drag (#842 item 3): one deleted meanwhile stays
       * deleted. And only while the order shown is still this drag's: a later drag that was saved is not undone by this
       * one failing.
       */
      set((s) => ({
        ...(stillInOrder(s.projects, orderedIds) ? { projects: inOrder(s.projects, Object.keys(before)) } : {}),
        toast: `Could not save order: ${(e as Error).message}`,
      }))
    }
  },
})
