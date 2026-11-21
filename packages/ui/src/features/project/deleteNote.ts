import type { ProjectInfo } from '@cc/protocol/client'

/** What the host says deleting the project may do to its folder (`projects.deleteOutlook`, #1301) */
export type DeleteOutlook = 'stays' | 'may_move' | 'around_may_move' | 'unsure'

const LEFT_ALONE = 'The folder on disk is left alone.'

/** Said while the host's answer is on its way: the dialog cannot be confirmed on a guess */
export const CHECKING = 'Checking what happens to the folder…'

/**
 * Added when the project's machine is not connected (#2330): the delete is taken now and done there on reconnect, so
 * what the sentences before it say happens then. The lead is the project tooltip's for that state (`ProjectDetail`).
 */
export function awayNote(machineName: string): string {
  return `Not connected to ${machineName}, so the project only leaves the list now. The rest happens on ${machineName} when it is connected again.`
}

/** What coming back is, the same in the sentences below */
const COMING_BACK =
  'Nothing is deleted: put it back into the apps folder under its app id and it is the app again, as a new project with its ' +
  'data, logs and versions (its secrets and grants are not kept).'

/** When the host moves a folder: never put as certain, since it also waits for the adoption's mark and for every path to resolve */
const WHEN = 'when no session that could bring the project back is left in Centralu’s session archive and no other project is at the folder'

/**
 * The dialog's folder sentence when the Trash box is off (#1301). An ordinary folder is left alone; a user-folder folder
 * registered in place (#1141) is the app, listed nowhere else, so the host may move it to `app-trash/` in its
 * computer's data folder (#1204), never put as certain (`WHEN`).
 * `outlook` is the host's real-path answer: a junction, link or `subst` drive counts; a project inside an app folder is
 * told so; an unresolvable path says so. `'pending'` while it comes. `null` (a host without the call): the mark
 * `ProjectInfo.fromUserFolder`, set by spelling alone, decides; a host that sends no mark gets the ordinary sentence.
 */
export function folderNote(project: Pick<ProjectInfo, 'fromUserFolder'>, outlook: DeleteOutlook | 'pending' | null = null): string {
  if (outlook === 'pending') return CHECKING
  const kind: DeleteOutlook = outlook ?? (project.fromUserFolder ? 'may_move' : 'stays')
  if (kind === 'stays') return LEFT_ALONE
  if (kind === 'around_may_move') {
    return (
      'This project lies inside an app folder from Centralu’s apps folder. Deleting it leaves its own folder alone, but the host may ' +
      'move the app folder around it to app-trash/ in the data folder of the computer it is on, when no project is left at or inside ' +
      'that folder and no session that could bring the app back is left in Centralu’s session archive. ' +
      COMING_BACK
    )
  }
  if (kind === 'unsure') {
    return (
      'Centralu could not check where this project’s folder is. If it is an app folder from Centralu’s apps folder, the host may move ' +
      `it to app-trash/ in the data folder of the computer it is on, ${WHEN}. ` +
      COMING_BACK
    )
  }
  return (
    'This project is an app folder from Centralu’s apps folder. The host may move the folder to app-trash/ in the data folder of the ' +
    `computer it is on, ${WHEN}. ` +
    COMING_BACK
  )
}
