import { gitRemoteKey, type PermissionPreset } from '@cc/protocol'
import { presetWithin } from './start-agent.js'

/** The words and presets of a child start_agent starts on a linked machine (#1038), apart from the hub's record of it (`RemoteAgents`) */

/** A machine's sentence to go inside another, without its own full stop */
export const bare = (error: string): string => error.trim().replace(/\.+$/, '')

/**
 * What became of a deleted child's worktree on its machine (#1161 item 3), as the rest of "It went to <machine>'s
 * trash": removed, or left and why. Nothing for a child started without a worktree.
 */
export function remoteWorktreeLine(
  rec: { worktree?: string },
  done: { worktree: 'removed' | 'kept' | 'none'; path?: string; branch?: string; why?: string; note?: string } | undefined,
): string {
  if (!rec.worktree) return ''
  if (!done) return `; its worktree there, on ${rec.worktree}, stays. The person deletes it on that machine`
  const where = `its worktree there${done.path ? ` (${done.path})` : ''}, on ${done.branch ?? rec.worktree}`
  // The machine's cleanup said what it did itself (the folder already gone, a branch kept by what it holds): said as it is
  if (done.note) return done.worktree === 'none' ? `; ${bare(done.note)}` : `; as for ${where}: ${bare(done.note)}`
  if (done.worktree === 'removed') return `, and ${where}, was removed with its branch: nothing in it was uncommitted or unpushed`
  if (done.worktree === 'none') return `; it had no worktree of its own there any more`
  return `; ${where}, was left: ${bare(done.why ?? 'the machine did not say why')}`
}

/**
 * A remote address as an answer may show it (#1038 review): the repository it names, never the address as written, which
 * can carry a user and a token (`https://user:ghp_…@github.com/…`). A local path is said to be one.
 */
export const shownRemote = (url: string | null): string => (url === null ? 'no origin' : (gitRemoteKey(url) ?? 'a local path'))

/**
 * The most a child on another machine runs under when its caller's `auto` is not carried (#1038 review, as
 * create_session over a link, #838): `normal`. An `auto` caller's is carried only to a machine that takes it (#1273,
 * `AutoThere`), as that machine's own switch says.
 */
export const remotePreset = (caller: PermissionPreset): PermissionPreset => (presetWithin(caller, 'normal') ? caller : 'normal')

/**
 * The caller's preset as `fromHub` carries it (#1273). The machine reads only `auto` from it; `edits` (#1525) is never put
 * on the link, because a machine from before it refuses a whole start for a value it does not know: it goes as `normal`,
 * the preset the child there runs under.
 */
export const carriedPreset = (caller: PermissionPreset): PermissionPreset => (caller === 'auto' ? 'auto' : remotePreset(caller))

/**
 * What a machine says of an `auto` caller's child (#1273, `LinkedSessions.hubAuto`): `auto`, it runs under `auto` there
 * too and no card is raised; otherwise why it runs under `normal` (its switch is off)
 */
export type AutoThere = { auto: true } | { auto: false; withheld: 'machine_off' }

/** What the start tells an `auto` caller of its child's preset (#1273), for its notice */
export const autoNotice = (machine: string, there: AutoThere): string =>
  there.auto
    ? `it runs under auto on ${machine}, as this session does`
    : `it runs under normal on ${machine}: that computer does not take auto from another computer (its "Allow auto from a linked computer" setting is off)`
