import type { ProjectInfo } from '@cc/protocol'

/**
 * What the Delete project dialog says about the folder when the person has not asked for it to go to the Trash (#1301).
 *
 * An ordinary project's folder is left alone. A folder of the user folder that was registered in place (#1141, `ProjectInfo.fromUserFolder`)
 * is not: it is the app, and nothing in the user folder lists it any more, so once nothing in Centralu still needs it (no
 * session of the project in the trash, no other project at the folder) the host moves it to `app-trash/` in the data folder
 * of the computer it is on (#1204). Nothing is deleted there, and a folder put back into the apps folder under its app id is
 * the app again, as a new project with its data, logs and versions; its secrets and grants are not kept (docs/apps.md). A
 * host from before the mark leaves it absent, which reads as ordinary.
 */
export function folderNote(project: Pick<ProjectInfo, 'fromUserFolder'>): string {
  if (!project.fromUserFolder) return 'The folder on disk is left alone.'
  return (
    'This project is an app folder from Centralu’s apps folder. Once nothing in Centralu still needs it — none of its sessions left in ' +
    'Centralu’s trash, no other project at the folder — the host moves the folder to app-trash/ in the data folder of the computer it ' +
    'is on. Nothing is deleted: put it back into the apps folder under its app id and it is the app again, as a new project with its ' +
    'data, logs and versions (its secrets and grants are not kept).'
  )
}
