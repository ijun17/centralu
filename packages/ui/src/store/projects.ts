import { forgetArrivalsOf } from './apps.js'
import { errorMessage, type ProjectInfo } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { forgetSessions } from './sessionList.js'
import { coalescedRead } from './single-flight.js'
import { machinesHoldingMirror } from './machines.js'
import { inOrder, omitKey, stillInOrder } from './patch.js'

/** What any client may change through the host (#719); `git` and the identity stay as the window has them */
const PROJECT_SETTING_KEYS = ['trusted', 'commands', 'worktreeSetup', 'agentInstructions', 'worktreeManager', 'defaultTool', 'defaultModels', 'fromUserFolder'] as const satisfies readonly (keyof ProjectInfo)[]

/*
 * A list read begun before this window's write finished may carry the old value, which the next whole-list save would
 * write back (#719). So a read leaves a project alone while its write is in flight or finished after the read began.
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
 * A listed row keeps its place and its object unless a `PROJECT_SETTING_KEYS` value differs. `git` is left alone: it has
 * its own refresh, and a list read is not the freshest count.
 * @returns whether a project had to be skipped after its write was already done, so one more read is due
 */
function applyProjects({ list, began }: { list: ProjectInfo[]; began: number }, set: StoreSet): boolean {
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

/** Asked about once for trust (#515), unless already trusted (the same folder chosen again) */
function joinProject(s: Pick<AppState, 'projects' | 'trustAsk'>, p: ProjectInfo): Pick<AppState, 'projects' | 'trustAsk'> {
  return { projects: { ...s.projects, [p.id]: p }, trustAsk: p.trusted ? s.trustAsk : p.id }
}

/**
 * One trailing window per project (#41) collapses a burst of triggers (sessions ending together, focus plus
 * visibilitychange) into one `git status`. 800 ms is under a glance, and lands after the edit an "allow" let through.
 */
const GIT_REFRESH_MS = 800

// Outside the store: nothing on screen reads a timer
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
  | 'saveAgentInstructions'
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
        throw new Error(`Could not set the trunk: ${errorMessage(e)}`)
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
    return coalescedRead(
      'projects',
      get,
      async (platform) => {
        const began = projectWrites.clock
        return { list: await platform.projects.list(), began }
      },
      (read) => applyProjects(read, set),
    )
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
        // Trust changed (#1141): the apps it has at the next app list read were on its card, so none is news
        forgetArrivalsOf(get, set, projectId)
        const running = Object.values(get().sessions).some((x) => x.projectId === projectId && x.live)
        if (running) set({ toast: 'Running sessions here pick up the new trust when they restart or resume.' })
      } catch (e) {
        set({ toast: `Could not change trust: ${errorMessage(e)}` })
      }
    })
  },

  async deleteProject(projectId, deleteFiles) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    if (deleteFiles) {
      // Its own door (#838): the file tree's trash refuses the project folder, so a repository link (`old-build -> .`)
      // cannot send it there. The shell moves it to the trash, never deletes.
      const r = await platform.fs.trashProjectFolder(projectId)
      if (!r.supported) throw new Error(r.reason ?? 'This build cannot delete files')
    }
    await platform.projects.remove(projectId)
    // Not left to `session_deleted`: waiting would leave rows of a project that is gone
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
        // A project re-added under its old id (a session restored from the archive) starts as a new one
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
        // The project can be gone by now (removed, or a reconnect rebuilt the list)
        if (!platform || !get().projects[projectId]) return
        // Re-reads the panel's own list too (#160), even with the summary unchanged: a second edit keeps the count
        set((s) => ({ gitEpoch: { ...s.gitEpoch, [projectId]: (s.gitEpoch[projectId] ?? 0) + 1 } }))
        void platform.projects
          .gitStatus(projectId)
          .then(({ git }) =>
            set((s) => {
              const cur = s.projects[projectId]
              // The common answer is "the same": a fresh object every turn would re-render the whole sidebar
              if (!cur || sameGit(cur.git, git)) return {}
              // git did not answer in time: the last count still stands rather than reading as none (#850)
              if (git?.unknown && cur.git) return {}
              // Only `git`: the host fills the rest from defaults, which would undo a `setProjectCommands` in flight
              return { projects: { ...s.projects, [projectId]: { ...cur, git } } }
            }),
          )
          // Silent: a margin number nobody asked for must not toast. The stale count stays.
          .catch(() => {})
      }, GIT_REFRESH_MS),
    )
  },

  /*
   * The writes (#49) refresh after the await: a status read that overtakes its commit writes the old repo back as news.
   * Staging refreshes too: it can drop a file matching HEAD from status, and an unchanged answer re-renders nothing.
   */
  async gitStage(projectId, paths, unstage) {
    await get().platform!.git.stage(projectId, paths, unstage)
    get().refreshProjectGit(projectId)
  },

  async gitCommit(projectId, message) {
    const res = await get().platform!.git.commit(projectId, message)
    // Even when refused: git can reject after moving something (a hook that stages, a partial index update)
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
      // The host's normalizing rule: an empty setup is `null`
      const clean = setup && (setup.command || setup.copyFiles.length) ? setup : null
      set((s) => {
        const now = s.projects[projectId]
        return now ? { projects: { ...s.projects, [projectId]: { ...now, worktreeSetup: clean } } } : {}
      })
    })
  },

  async saveAgentInstructions(projectId, text) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      await platform.projects.setAgentInstructions(projectId, text)
      // As the host keeps them (trimmed), so the dialog opens on what is stored
      set((s) => {
        const now = s.projects[projectId]
        return now ? { projects: { ...s.projects, [projectId]: { ...now, agentInstructions: text.trim() } } } : {}
      })
    })
  },

  async setProjectCommands(projectId, commands) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await writingProject(projectId, () => void get().refreshProjects(), async () => {
      // Drawn first: a row that appears only after a round trip reads as a missed click
      set((s) => ({ projects: { ...s.projects, [projectId]: { ...(s.projects[projectId] ?? before), commands } } }))
      try {
        const saved = await platform.projects.setCommands(projectId, commands)
        set((s) => {
          const now = s.projects[projectId]
          // The project may be gone meanwhile
          return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: saved } } } : {}
        })
      } catch (e) {
        // The old list back, said: a command that looks saved and is gone next launch reads as never added
        set((s) => {
          // Only the list goes back (#842 item 3): a rename made meanwhile stays, and a project removed meanwhile is not revived
          const now = s.projects[projectId]
          return {
            ...(now ? { projects: { ...s.projects, [projectId]: { ...now, commands: before.commands } } } : {}),
            toast: `Could not save commands: ${errorMessage(e)}`,
          }
        })
        // Then the host's own list: another save made meanwhile rolls back to a list the host never had, and a removal
        // the host refused takes seconds, long enough for one (#2472)
        const held = (await platform.projects.list().catch(() => null))?.find((x) => x.id === projectId)?.commands
        if (held) set((s) => {
          const now = s.projects[projectId]
          return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: held } } } : {}
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
      // Re-read the next time the panel opens
    }
  },

  async runCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    try {
      // A starting size; `CommandLog` measures the real one when it attaches
      const info = await platform.commands.run(projectId, command, 100, 30)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: { ...s.commandRuns[projectId], [command]: info },
        },
      }))
    } catch (e) {
      // Said: believing it started leaves someone waiting on a log that never comes
      set({ toast: `Could not run: ${errorMessage(e)}` })
    }
  },

  async stopCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    // Marked before asking, so its exit reads as a stop: "exit 143" drawn as a failure after Stop reads as a crash.
    // Only the run running now is marked; a re-run meanwhile is a new record.
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
      // As `runCommand` (#841 item 11): a stop that failed silently would leave the badge lit, read as "it is stopping"
      mark(false)
      set({ toast: `Could not stop: ${errorMessage(e)}` })
    }
  },

  async watchProjectDirs(projectId, dirs) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.fs.watch(projectId, dirs)
      watchFailureSaid.delete(projectId)
    } catch (e) {
      // The tree goes on (#34) but says it (#841), or it silently stops following changes. Once: every opened folder asks again
      if (watchFailureSaid.has(projectId)) return
      watchFailureSaid.add(projectId)
      set({ toast: `The file tree will not follow changes made outside it: ${errorMessage(e)}` })
    }
  },

  /** The screen moves first and the save follows: a drag that waits for a round trip feels like it stumbled */
  async reorderProjects(orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().projects
    set({ projects: Object.fromEntries(orderedIds.map((id) => [id, before[id]!]).filter(([, v]) => v)) })
    try {
      const fresh = await platform.projects.reorder(orderedIds)
      set({ projects: Object.fromEntries(fresh.map((p) => [p.id, p])) })
      // A machine that could not take the order answers from the hub's mirror; a connected one is read again (#1611)
      for (const id of machinesHoldingMirror(get())) void get().recoverMachine(id)
    } catch (e) {
      // Only the order goes back (#842), and only while the order shown is still this drag's
      set((s) => ({
        ...(stillInOrder(s.projects, orderedIds) ? { projects: inOrder(s.projects, Object.keys(before)) } : {}),
        toast: `Could not save order: ${errorMessage(e)}`,
      }))
    }
  },
})
