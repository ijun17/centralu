// Decisions, three tools (#1143, P17): save_answer (the screen saves or deletes the owner's answer),
// list_owner_answers (the answers, the "Needs decision" items, what each asks) and mark_answer_recorded.
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { answerFor, answerKey, commentIdOf, deleteAnswer, markRecorded, saveAnswer, unrecorded } from './answers.mjs'
import { board, byPriority, detailInput, fieldsOf, itemInput, itemOf, itemsAnswer, matches, refOf, refreshInput } from './board.mjs'
import { config } from './config.mjs'
import { GitHubError, readComment, resolveOption } from './github.mjs'
import { answering, forView, serially } from './handlers.mjs'
import { decisionSummary } from './markdown.mjs'
import { answer, linesAnswer, reason } from './reply.mjs'
import { englishProblems } from './rules.mjs'
import { renderOpts, summaryView, thread } from './threads.mjs'
import { mapLimit, plural } from './util.mjs'
import { now as clock } from './clock.mjs'

// --- The owner's answers: on this machine, never on GitHub as written --------------------------------
// The screen saves the owner's answer to a "Needs decision" item in this app's data folder (outside
// the repository, which is public); an agent lists the answers not recorded yet, records each decision
// on its issue in English with `comment`, and marks the answer recorded with that comment's address.
const ANSWERS_FILE = 'owner-answers.json'
let answers = null
export async function ownerAnswers() {
  answers ??= (await centralu.readJson(ANSWERS_FILE, { answers: [] }))?.answers ?? []
  return answers
}
async function keepAnswers(list) {
  await centralu.writeJson(ANSWERS_FILE, { answers: list })
  answers = list
}

/** What the screen and the decision lists show of an item's answer (null: none). */
export const answerView = (a) => (a ? { text: a.text, savedAt: a.savedAt, updatedAt: a.updatedAt, recordedAt: a.recordedAt, recordedUrl: a.recordedUrl } : null)
const NOT_RECORDED = 'answered, not recorded yet'

async function titleOf(want, given) {
  if (given) return given
  const b = await board().catch(() => null)
  return b?.items.find(matches(want))?.title ?? null
}

async function saveOwnerAnswer({ item, text, title }) {
  const want = itemOf(item)
  const ref = want.ref
  let r
  try {
    r = saveAnswer(await ownerAnswers(), { repository: want.repo, number: want.number, title: await titleOf(want, title), text, now: new Date(clock()).toISOString() })
  } catch (e) {
    throw new GitHubError('input', `Not saved: ${e.message}`)
  }
  await keepAnswers(r.list)
  return answer(`${r.replaced ? 'Saved the changed answer' : 'Saved the answer'} on ${ref} on this computer only; nothing went to GitHub. An agent records the decision on ${ref} in English.`, {
    ok: true,
    ref,
    answer: answerView(r.answer),
  })
}

async function deleteOwnerAnswer({ item }) {
  const want = itemOf(item)
  const ref = want.ref
  let r
  try {
    r = deleteAnswer(await ownerAnswers(), want.repo, want.number)
  } catch (e) {
    throw new GitHubError('input', `Not deleted: ${ref}: ${e.message}`)
  }
  await keepAnswers(r.list)
  return answer(`Deleted the answer on ${ref}.`, { ok: true, ref, answer: answerView(answerFor(r.list, want.repo, want.number)) })
}

async function listOwnerAnswers({ all }) {
  const list = await ownerAnswers()
  const shown = all ? list : unrecorded(list)
  const lines = shown.map(
    (a) =>
      `${refOf(a.repository, a.number)}${a.title ? ` ${a.title}` : ''} — ${a.recordedAt ? `recorded ${a.recordedAt.slice(0, 10)}: ${a.recordedUrl}` : `${NOT_RECORDED}, saved ${(a.updatedAt ?? a.savedAt).slice(0, 16).replace('T', ' ')} UTC`}\n  ${a.text.replace(/\n/g, '\n  ')}`,
  )
  const waiting = unrecorded(list).length
  const summary = `${plural(waiting, 'owner answer')} not recorded yet${all ? `, ${list.length} kept` : ''}.${waiting ? ' For each: post the decision on its issue in English with comment, starting "**Decision (owner, YYYY-MM-DD):**" (CONTRIBUTING.md), then mark_answer_recorded with that comment\'s address.' : ''}`
  return linesAnswer(summary, [['answers', '', lines]], {
    count: waiting,
    items: shown.map((a) => ({ ref: refOf(a.repository, a.number), repository: a.repository, number: a.number, title: a.title, ...answerView(a) })),
  })
}

async function markOwnerAnswer({ item, url }) {
  const want = itemOf(item)
  const ref = want.ref
  const id = commentIdOf(url, want.repo, want.number)
  if (id.problem) throw new GitHubError('input', `Not marked: ${id.problem}`)
  const list = await ownerAnswers()
  if (!unrecorded(list).some((a) => answerKey(a.repository, a.number) === answerKey(want.repo, want.number))) throw new GitHubError('input', `Not marked: ${ref} has no answer waiting to be recorded.`)
  // The comment is read back: it exists, it is on this item, and it records the decision in English
  const c = await readComment(want.repo, id.id)
  const problems = []
  if (!c || c.number !== want.number) problems.push(`GitHub has no comment ${id.id} on ${ref}.`)
  else {
    if (!/Decision \(owner, \d{4}-\d{2}-\d{2}\)/.test(c.body)) problems.push('The comment does not hold "Decision (owner, YYYY-MM-DD)", the form a decision is recorded in (CONTRIBUTING.md).')
    problems.push(...englishProblems(c.body, 'The comment'))
  }
  if (problems.length) throw new GitHubError('input', `Not marked: ${problems.join(' ')}`)
  const r = markRecorded(list, want.repo, want.number, url, new Date(clock()).toISOString())
  await keepAnswers(r.list)
  return answer(`Marked the owner's answer on ${ref} recorded: ${url}`, { ok: true, ref, answer: answerView(r.answer) })
}

// The "Needs decision" items, one line each; an answer waiting shows on its line
async function needsDecision({ area, detail }) {
  const b = await board()
  const decision = resolveOption(b.fields.status, config.decisionStatus).name
  const wantArea = area === undefined ? null : resolveOption(b.fields.area, area).name
  const items = b.items.filter((i) => i.status === decision && (!wantArea || i.area === wantArea)).sort(byPriority)
  const waiting = new Set(unrecorded(await ownerAnswers()).map((a) => answerKey(a.repository, a.number)))
  const answered = (i) => i.number != null && waiting.has(answerKey(i.repository, i.number))
  const n = items.filter(answered).length
  const summary = `${b.project.title}: ${plural(items.length, 'item')} with Status ${decision}${wantArea ? ` in Area ${wantArea}` : ''}${n ? `, ${n} ${NOT_RECORDED} (list_owner_answers)` : ''}.`
  return itemsAnswer(b, summary, items, detail, [], (i) => (answered(i) ? ` · ${NOT_RECORDED}` : ''))
}

async function decisionSummaries({ refresh }) {
  const b = await board({ fresh: refresh === true })
  const decision = resolveOption(b.fields.status, config.decisionStatus).name
  const items = b.items.filter((i) => i.status === decision && i.number != null && i.repository).sort(byPriority)
  const saved = await ownerAnswers()
  const rows = await mapLimit(items, 4, async (i) => {
    const row = { ref: refOf(i.repository, i.number), repository: i.repository, number: i.number, title: i.title, url: i.url, type: i.type, ...fieldsOf(i), ownerAnswer: answerView(answerFor(saved, i.repository, i.number)) }
    try {
      const t = await thread(i.repository, i.number, { fresh: refresh === true })
      return { ...row, comments: t?.totalComments ?? 0, decision: t ? summaryView(decisionSummary(t.comments), renderOpts(t)) : null }
    } catch (e) {
      return { ...row, error: reason(e) }
    }
  })
  const without = rows.filter((r) => !r.error && !r.decision).length
  const summary = `${plural(rows.length, 'item')} with Status ${decision}${without ? `, ${without} without a summary comment` : ''}.`
  return answer(summary, { ok: true, decisionStatus: decision, items: rows, fetchedAt: b.fetchedAt })
}

// Each option belongs to one view; one meant for another is refused, so an agent that moved from the old
// list_needs_decision (area, detail) without view "items" is told so and not given the answers list.
const VIEW_OF = { all: 'answers', area: 'items', detail: 'items', refresh: 'summaries' }
const VIEWS = { answers: listOwnerAnswers, items: needsDecision, summaries: decisionSummaries }
function listed(args) {
  const view = args.view ?? 'answers'
  const stray = Object.keys(VIEW_OF).filter((k) => args[k] !== undefined && args[k] !== false && VIEW_OF[k] !== view)
  if (stray.length) throw new GitHubError('input', `Not listed: ${stray.map((k) => `${k} is for view "${VIEW_OF[k]}"`).join(', ')}, not for view "${view}".`)
  return VIEWS[view](args)
}

export const tools = {
  // The owner's answer, saved or deleted on this machine only (never posted as written: the repository is
  // public). Screen-only; agents read and close them with the two tools after this.
  save_answer: {
    config: {
      title: "Save or delete the owner's answer",
      description:
        "Save the person's answer to an item from the screen in this app's data folder on this computer, never on GitHub. Saving again replaces the answer not recorded yet; remove: true deletes it while it is not recorded yet. An agent records the decision on the issue in English and marks the answer recorded.",
      inputSchema: z.object({
        item: itemInput,
        text: z.string().max(65536).optional().describe('The answer, in any language'),
        title: z.string().max(512).optional().describe("The item's title, kept for the agent's list"),
        remove: z.boolean().optional().describe('Delete the saved answer instead of saving'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      _meta: { ui: { visibility: ['app'] } },
    },
    handler: serially(answering((args) => (args.remove ? deleteOwnerAnswer(args) : saveOwnerAnswer(args)))),
  },

  // Read by agents (the answers waiting, the items) and by the screen (summaries)
  list_owner_answers: {
    config: {
      title: "The owner's decisions and answers",
      description: `By default the answers the owner saved on the board's screen to "${config.decisionStatus}" items and no agent has recorded yet (all: true adds the recorded ones), each with the item, its title and the text as the owner wrote it (often not English; never post it as written). For each: post the decision on its issue in English with comment, starting "**Decision (owner, YYYY-MM-DD):**", then call mark_answer_recorded with that comment's address. view "items": the items whose Status is "${config.decisionStatus}", highest priority first, one line each, optionally one Area, marked when an answer waits. view "summaries" is the screen's: those items as data with the question, options and recommendation of its latest "Decision needed (summary, …)" comment as HTML; a failure comes as ok: false.`,
      inputSchema: z.object({
        view: z.enum(['answers', 'items', 'summaries']).optional().describe('Default "answers"'),
        all: z.boolean().optional().describe('answers: also the answers already recorded; default false'),
        area: z.string().optional().describe('items: only this Area, for example "UI"'),
        detail: detailInput.describe('items: "full" adds type, state, URL and ids'),
        refresh: refreshInput.describe('summaries: skip the short cache and ask GitHub now'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: (args, ctx) => (args.view === 'summaries' ? forView(listed) : answering(listed))(args, ctx),
  },

  mark_answer_recorded: {
    config: {
      title: "Mark the owner's answer recorded",
      description:
        `Mark the owner's saved answer on an item recorded, with the address of the English decision comment posted on it with comment (https://github.com/owner/name/issues/N#issuecomment-ID). The comment is read back from GitHub: it must be on that item, hold "Decision (owner, YYYY-MM-DD)" and be in English.`,
      inputSchema: z.object({ item: itemInput, url: z.string().describe("The decision comment's address on GitHub") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'centralu/risk': 'local', ui: { visibility: ['model'] } },
    },
    handler: serially(answering(markOwnerAnswer)),
  },
}
