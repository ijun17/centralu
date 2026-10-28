import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { KILL_GRACE_MS, collectOrphansWindows, hasProcessGroups, stopGroup, type EndedRoot, type KillablePty, type LeftoverOs } from './kill-tree.js'

/**
 * A child this host starts as the root of a tree it can end, with what it leaves behind: the start and the sweep that
 * an app process (`apps/external/app-process.ts`) and an agent CLI without a keeper (`adapters/local-process.ts`) share
 * (#428). How and when each stops its child stays with it; this is the physics both rely on.
 *
 * - **macOS and Linux.** The child leads a process group of its own (`detached`), so what it starts is in that group
 *   and not in the host's. Once it has exited, the group is swept (`stopGroup`): helpers that outlived it are no longer
 *   under it in `ps`, but they are still in its group, whose number is not reused while anyone is in it.
 * - **Windows** has no groups, and there `detached` means a process with no console, whose every console child opens a
 *   visible window (#14): the child is started attached and hidden. Once it has exited, what it left running is found
 *   by parent links and creation times (`collectOrphansWindows`), which needs **when it was started, taken before the
 *   spawn**: a time taken after it could be later than the creation of a child the process started at once, and that
 *   child would no longer count as its own.
 */

export type GroupedChild = {
  child: ChildProcess
  /** `Date.now()` just before the spawn, so it is no later than the process's own creation time (`EndedRoot`) */
  spawnedAt: number
  /**
   * When the host saw it exit (its `'exit'`), or null while it runs: the other end of the window in which what it
   * left was created. Not the time of the sweep: by then Windows may have given its pid to another program, whose
   * children would fall inside the window and be ended (#1650 review).
   */
  exitedAt(): number | null
}

/** `child`, started just after `spawnedAt`, with the time of its exit recorded: the one definition of `exitedAt` */
export function tracked(child: ChildProcess, spawnedAt: number): GroupedChild {
  let exitedAt: number | null = null
  child.once('exit', () => {
    exitedAt = Date.now()
  })
  return { child, spawnedAt, exitedAt: () => exitedAt }
}

/** Starts `command` in a group of its own (not on Windows, see the file header), hidden */
export function spawnGrouped(command: string, args: readonly string[], opts: SpawnOptions, platform?: NodeJS.Platform): GroupedChild {
  const spawnedAt = Date.now()
  const child = spawn(command, [...args], { ...opts, detached: hasProcessGroups(platform), windowsHide: true })
  return tracked(child, spawnedAt)
}

const isSignal = (name: string): name is NodeJS.Signals => Object.prototype.hasOwnProperty.call(constants.signals, name)

/** The signal `name` names, or the error `kill` itself throws for one it does not know */
function signalNamed(name: string): NodeJS.Signals {
  if (!isSignal(name)) throw new TypeError(`Unknown signal: ${name}`)
  return name
}

/** A `ChildProcess` as kill-tree's handle (`killTree`, `stopTree`): its pid and its kill, written once for every caller */
export function killHandle(child: ChildProcess): KillablePty {
  return { pid: child.pid, kill: (signal?: string) => void child.kill(signal === undefined ? undefined : signalNamed(signal)) }
}

/**
 * Ends what an exited grouped child left running (see the file header). macOS and Linux: its group gets TERM, and
 * KILL after the grace. Windows: its leftovers are collected, which takes a process listing (~0.5 s); the promise
 * answers the pids ended, and never rejects.
 */
export function sweepExited(root: EndedRoot, platform?: NodeJS.Platform, os?: LeftoverOs): Promise<number[]> {
  if (hasProcessGroups(platform)) {
    stopGroup(root.pid, KILL_GRACE_MS)
    return Promise.resolve([])
  }
  return collectOrphansWindows(root, os).catch(() => [])
}

/**
 * `sweepExited` for a child started with `spawnGrouped` (or `tracked`), once it has exited: the window of what it left
 * is from its spawn to its exit as recorded (`exitedAt`), never to now. Nothing for a child that never started.
 */
export function sweepLeftovers(started: GroupedChild, platform?: NodeJS.Platform, os?: LeftoverOs): Promise<number[]> {
  const pid = started.child.pid
  if (pid === undefined) return Promise.resolve([])
  return sweepExited({ pid, spawnedAt: started.spawnedAt, exitedAt: started.exitedAt() ?? Date.now() }, platform, os)
}
