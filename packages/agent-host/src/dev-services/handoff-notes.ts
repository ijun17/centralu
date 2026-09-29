import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isProjectId, isSessionId } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'

/**
 * Where a handoff note lives (#142) — **under the data folder**,
 * `<data>/handoff/<project id>/<session id>.md`.
 *
 * The old location was `<project>/.centralu/handoff/`, which is to say inside the user's own
 * repository. Two things were wrong there. The note was not ignored by git — the rule excluding
 * that folder lived only in **this repository's own** .gitignore, and we do not touch the user's
 * .gitignore or `.git/info/exclude`. And cleanup trusted that folder blindly: committing
 * `.centralu/handoff -> ..` into a repository meant that when a cloned copy's host started up, it
 * followed the link and deleted the README.md at the repository root (measured). A folder we
 * write to and delete from has to be ours.
 *
 * **The old location is never read, written to, or cleaned up.** A note already sitting there is
 * the user's own repository file, so it is neither moved nor deleted — an old successor session's
 * first message still points at that path, and the file stays where it is.
 *
 * **Why the folder is split per project**: a successor Claude session only gets to read the
 * folder holding its note without asking if it is granted as an additional working directory
 * (`CreateSessionOpts.readableDirs` — the measurement is written there). Splitting by project
 * means that grant stops at the same project's own notes. Pooling them into one folder would open
 * every project's notes together.
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
    throw Object.assign(new Error(`Not a project id: ${projectId}`), { code: 'internal' })
  }
  return join(root(), projectId)
}

/** One handing-off session's note — since its name is the session id, two handoffs running at once never contend for the same spot (#104) */
export function handoffNotePath(projectId: string, sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw Object.assign(new Error(`Not a session id: ${sessionId}`), { code: 'internal' })
  }
  return join(handoffNoteDir(projectId), `${sessionId}.md`)
}

/** How much one session's note takes — the trash shows what it holds (#204). 0 when it has none */
export async function handoffNoteBytes(projectId: string, sessionId: string): Promise<number> {
  const s = await lstat(handoffNotePath(projectId, sessionId)).catch(() => null)
  return s?.isFile() ? s.size : 0
}

/** Writes the note and returns its absolute path. The host is always the writer — an agent never writes into this folder */
export async function writeHandoffNote(projectId: string, sessionId: string, text: string): Promise<string> {
  const path = handoffNotePath(projectId, sessionId)
  await mkdir(handoffNoteDir(projectId), { recursive: true })
  // Whatever is already there is removed first (#104) — a link sitting at that spot would have the write follow it
  await rm(path, { force: true })
  await writeFile(path, text, 'utf8')
  return path
}

/**
 * Deletes a note with no owner (#106). Which one has an owner is something the caller knows
 * (`owned`).
 *
 * **Only directories and regular files are looked at.** Both the folder and the files in it are
 * created only by the host, but cleanup that followed a link and deleted through it is what
 * started this issue — an entry from `withFileTypes` never follows a link and answers as the link
 * itself, so a link never shows up as either a folder or a file.
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
      await rm(join(dir, e.name), { force: true }).catch(() => {})
    }
  }
}
