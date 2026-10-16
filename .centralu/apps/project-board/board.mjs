// The board itself: read from GitHub with a short cache, and written the same way in every answer
// (one line per item). Every tool family reads items by number through `itemOf` here.
import { z } from './runtime/centralu-app-runtime.mjs'
import { freshCache } from './cache.mjs'
import { CACHE_MS, config } from './config.mjs'
import { checkRepo, parseItemRef, readBoard, sameRepo } from './github.mjs'
import { linesAnswer } from './reply.mjs'

// --- The short cache -------------------------------------------------------------------------------
// One board in memory, for at most CACHE_MS. A write forgets it, and a read that started before a
// write never refills it (the generation check), so a tool never answers from a board older than
// its own last write.
// The same cache as the reader's threads (cache.mjs), with one key.
const boards = freshCache({ ttlMs: CACHE_MS })
export const board = ({ fresh = false } = {}) => boards.get('board', () => readBoard(config), { fresh })
export const forget = () => boards.forget('board')

// --- Presenting ------------------------------------------------------------------------------------
// What the model reads is short: one line per item, and the same words in the text and in
// structuredContent (docs/apps.md §9.2: Claude Code hands the model the structured part, not the
// text). URLs and ids only when `detail: "full"` asks for them.
export const FIELDS = ['status', 'priority', 'area']
const TYPE = { issue: 'issue', pull: 'pull request', draft: 'draft issue', hidden: 'hidden item' }
export const refOf = (repo, number) => (sameRepo(repo, config.repository) ? `#${number}` : `${repo}#${number}`)
const ref = (item) => (item.number == null ? TYPE[item.type] : refOf(item.repository, item.number))
const label = (item) => `${ref(item)} ${item.title}`
export const none = (v) => v ?? '(none)'
/** `#113 Narrow-window reading — Needs decision · Medium · UI`; a pull request says so. */
const line = (item) =>
  `${label(item)}${item.type === 'pull' ? (item.draft ? ' (draft PR)' : ' (PR)') : ''} — ${none(item.status)} · ${none(item.priority)} · ${none(item.area)}`
const fullLine = (item) =>
  `${line(item)} · ${TYPE[item.type]}${item.state ? ` ${item.state.toLowerCase()}` : ''}${item.url ? ` · ${item.url}` : ''} · item ${item.itemId}`

/** Status columns in the project's own order, with the decision column first. */
export function columns(b) {
  const names = b.fields.status.options.map((o) => o.name)
  const first = names.find((n) => n.toLowerCase() === String(config.decisionStatus).toLowerCase())
  return first ? [first, ...names.filter((n) => n !== first)] : names
}
export const where = (b) => `${b.project.title} (GitHub Project #${b.project.number} of ${b.project.owner}), read from GitHub at ${b.fetchedAt}`
const RANK = { High: 0, Medium: 1, Low: 2 }
export const byPriority = (a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || (a.number ?? 0) - (b.number ?? 0)

// --- Reading items by number ------------------------------------------------------------------------
export const itemRef = z.union([z.string(), z.number()])
export const REF_HELP = '8, "#8", "owner/repo#8" or its URL'
export const detailInput = z.enum(['compact', 'full']).optional().describe('"full" adds type, state, URL and ids; default "compact"')
export const itemInput = itemRef.describe(`The issue or pull request: ${REF_HELP}`)
export const refreshInput = z.boolean().optional().describe('Skip the short cache and ask GitHub now')
export const repoInput = z.string().optional().describe("owner/name; default this project's repository")
export const pathInput = z.string().optional().describe('A checkout of the repository; default the one this app is in')

export const matches = (want) => (i) => i.number === want.number && sameRepo(i.repository, want.repo)

/** An issue or pull request asked for (parseItemRef), with the way answers write it. */
export function itemOf(input, defaultRepo = config.repository) {
  const want = parseItemRef(input, defaultRepo)
  return { ...want, ref: refOf(want.repo, want.number) }
}
export const unseen = (ref) => `${ref} is not an issue or pull request this GitHub login can see.`

/**
 * Finds the items asked for, in the order asked, once each. A reference that is not an issue or pull
 * request fails the whole read (the model sent something wrong); one that is not in the project is
 * named in `missing`.
 */
export function pick(b, inputs) {
  const found = []
  const missing = []
  const seen = new Set()
  for (const input of inputs) {
    const want = itemOf(input)
    const key = `${want.repo.toLowerCase()}#${want.number}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = b.items.find(matches(want))
    if (item) found.push(item)
    else missing.push(want.ref)
  }
  return { found, missing }
}

/** The read tools' answer: compact lines, or with `full` the whole items and where they came from. */
export function itemsAnswer(b, summary, items, detail, extra = [], suffix = () => '') {
  const full = detail === 'full'
  const lists = [['items', '', items.map((i) => `${(full ? fullLine : line)(i)}${suffix(i)}`)], ...extra]
  if (!full) return linesAnswer(summary, lists)
  const a = linesAnswer(`${summary} ${where(b)}.`, lists, { project: b.project, fetchedAt: b.fetchedAt })
  a.structuredContent.items = items
  return a
}

export const fieldsOf = (item) => ({ status: item?.status ?? null, priority: item?.priority ?? null, area: item?.area ?? null })

export const repoOf = (repo) => {
  const r = repo ?? config.repository
  checkRepo(r)
  return r
}
