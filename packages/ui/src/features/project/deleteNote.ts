import type { ProjectInfo } from '@cc/protocol/client'

/** What the host says deleting the project may do to its folder (`projects.deleteOutlook`, #1301) */
export type DeleteOutlook = 'stays' | 'may_move' | 'around_may_move' | 'unsure'

const LEFT_ALONE = 'The folder on disk is left alone.'

/** Said while the host's answer is on its way: the dialog cannot be confirmed on a guess */
export const CHECKING = 'Checking what happens to the folder…'

/** What coming back is, the same in the sentences below */
const COMING_BACK =
  'Nothing is deleted: put it back into the apps folder under its app id and it is the app again, as a new project with its ' +
  'data, logs and versions (its secrets and grants are not kept).'

/** When the host moves a folder: never put as certain, since it also waits for the adoption's mark and for every path to resolve */
const WHEN = 'when no session that could bring the project back is left in Centralu’s session archive and no other project is at the folder'

/**
 * What the Delete project dialog says of the folder when the person has not asked for it to go to the Trash (#1301).
 *
 * An ordinary project's folder is left alone. A folder of the user folder that was registered in place (#1141) is not: it is
 * the app, and nothing in the user folder lists it any more, so the host **may** move it to `app-trash/` in the data folder of
 * the computer it is on (#1204) — never put as certain: the move also waits for the folder to carry the adoption's mark, and for
 * every project and trash path to resolve.
 *
 * `outlook` is the host's answer, asked when the dialog opens with real-path matching: a project added again through a junction,
 * a link or a `subst` drive counts; one inside an app folder is told so without being called an app folder itself; one whose
 * path could not be told from an app folder's says so. `'pending'` while it comes. From a host without the call (`null`) the
 * mark `ProjectInfo.fromUserFolder` decides (set by spelling alone), and a host from before the mark leaves it absent: the
 * ordinary sentence.
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
