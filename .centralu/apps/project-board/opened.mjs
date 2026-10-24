// The pull requests `open_pr` opened, and the session that opened each (#1509 item 4). The merge queue reads it to do
// what the opening session would be told to do by hand: mark its own draft ready when that same session queues it,
// and post a conflict to the author session itself instead of asking the queuing session to relay it.
//
// Kept in its own small file in the app's data folder (`opened-prs.json`), not in the queue file: `open_pr` writes it
// from a tool call, the queue reads it from the server or from a watch command, and `open_pr` must not import the
// queue (the queue's integrator imports `open_pr`). Written whole and synchronously, so a reader never sees half.
//
// `notice` is the opening session's notice address (`centralu.noticeAddress()`, docs/apps.md §10): a MAC over (app,
// session), stable across calls and restarts, which opens only for a session that called this app. It is never shown
// in an answer. A pull request opened by an older Centralu, or by the release tool, has none, and then nothing here
// applies to it.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPENED_FILE = 'opened-prs.json'
/** How many are kept: the newest; a pull request is queued within hours of being opened */
export const OPENED_MAX = 300

const keyOf = (repo, number) => `${String(repo).toLowerCase()}#${Number(number)}`

/** The records by `repo#number`; a missing or unreadable file is no records (a nicety, never a reason to stop). */
export function readOpened(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, OPENED_FILE), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** Adds one: `{ repo, number, notice, draft, at }`. Oldest dropped past OPENED_MAX. */
export function noteOpened(dir, { repo, number, notice = null, draft = false, at = new Date().toISOString() }) {
  if (!notice) return
  const all = readOpened(dir)
  delete all[keyOf(repo, number)]
  all[keyOf(repo, number)] = { notice, draft: draft === true, at }
  const kept = Object.fromEntries(Object.entries(all).slice(-OPENED_MAX))
  const tmp = join(dir, `${OPENED_FILE}.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(kept)}\n`)
  renameSync(tmp, join(dir, OPENED_FILE))
}

/** The record of a pull request, or null. */
export const openedBy = (opened, repo, number) => opened?.[keyOf(repo, number)] ?? null
