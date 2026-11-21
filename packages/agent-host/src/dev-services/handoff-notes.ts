import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isProjectId, isSessionId } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'
import { dataBytes, removeData, removeDataSync } from './data-folder.js'
import { rpcError } from '../rpc-error.js'

/**
 * Where a handoff note lives (#142): **under the data folder**, `<data>/handoff/<project id>/<session id>.md`.
 *
 * Not `<project>/.centralu/handoff/`, inside the user's repository: we do not touch its .gitignore or `.git/info/exclude`,
 * so the note would not be ignored, and a committed `.centralu/handoff -> ..` made a clone's host follow the link in
 * cleanup and delete the README.md at its root (measured). A folder we write to and delete from has to be ours.
 * **That folder is never read, written or cleaned up**: a note there is the user's repository file, left where it is
 * (an older successor's first message may point at it).
 *
 * **Split per project**: a successor Claude session reads its note's folder without asking only if it is granted as a
 * working directory (`CreateSessionOpts.readableDirs`, where the measurement is); one pooled folder would open every
 * project's notes.
 */
// **This is a function.** Deciding this at module load time would bake in the value from before
// the host has settled on a data folder (the same reasoning as attachments.ts)
const root = () => join(dataRoot(), 'handoff')

/**
 * One project's note folder. Here, the project id is also a path segment — **rejected if it is
 * not exactly one segment** (#132). The boundary (`ProjectId`) already filters this, but the side
 * building the path checks it again itself — cleanup does not go through the RPC layer.
 */
export function handoffNoteDir(projectId: string): string {
  if (!isProjectId(projectId)) {
    throw rpcError(`Not a project id: ${projectId}`)
  }
  return join(root(), projectId)
}

/** One handing-off session's note — since its name is the session id, two handoffs running at once never contend for the same spot (#104) */
export function handoffNotePath(projectId: string, sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw rpcError(`Not a session id: ${sessionId}`)
  }
  return join(handoffNoteDir(projectId), `${sessionId}.md`)
}

/** How much one session's note takes — the session archive shows what it holds (#204). 0 when it has none */
export async function handoffNoteBytes(projectId: string, sessionId: string): Promise<number> {
  return dataBytes(handoffNotePath(projectId, sessionId))
}

/** Writes the note and returns its absolute path. The host is always the writer — an agent never writes into this folder */
export async function writeHandoffNote(projectId: string, sessionId: string, text: string): Promise<string> {
  const path = handoffNotePath(projectId, sessionId)
  await mkdir(handoffNoteDir(projectId), { recursive: true })
  // Whatever is already there is removed first (#104) — a link sitting at that spot would have the write follow it
  await removeData(path)
  await writeFile(path, text, 'utf8')
  return path
}

/**
 * The same write without an await (#693): a handoff rewrites the note with the children it moved between the move and
 * the successor's first message, and no other event may land in between (a moved child's report would reach the
 * successor before its opening). The note is one small file in the host's own folder.
 */
export function writeHandoffNoteSync(projectId: string, sessionId: string, text: string): string {
  const path = handoffNotePath(projectId, sessionId)
  mkdirSync(handoffNoteDir(projectId), { recursive: true })
  removeDataSync(path)
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * Deletes a note with no owner (#106). Which one has an owner is something the caller knows
 * (`owned`).
 *
 * **Only directories and regular files are looked at**, though only the host creates them: cleanup must never delete
 * through a link, and an entry from `withFileTypes` answers as the link itself, never as a folder or a file.
 *
 * **An empty folder is left as-is** (#104) — cleanup that took the whole folder away would also
 * carry off the text of a handoff that started in the meantime.
 */
export async function sweepHandoffNotes(owned: (sessionId: string) => boolean, projectId?: string): Promise<void> {
  let dirs: string[]
  try {
    dirs = projectId
      ? [projectId]
      : (await readdir(root(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return // no handoff has ever happened — nothing to delete
  }
  for (const pid of dirs) {
    let dir: string
    try {
      dir = handoffNoteDir(pid)
    } catch {
      continue // a name we did not create — left untouched
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const owner = e.name.slice(0, -'.md'.length)
      if (owned(owner)) continue
      await removeData(join(dir, e.name)).catch(() => {})
    }
  }
}
