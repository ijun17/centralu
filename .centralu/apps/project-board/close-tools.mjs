// close_issue (#2488): an issue that plans items closes only when each was built, carried by another issue or dropped with a
// reason; and the same question for an issue a pull request closes, which queue_merge and integrate ask.
import { z } from './runtime/centralu-app-runtime.mjs'
import { forget, itemInput, itemOf } from './board.mjs'
import { GitHubError, ownFailure, postComment, readIssue, readRepo, readRepoFile, setIssueClosed } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { citedPlans, planItems, PLANS, planSection } from './plan-items.mjs'
import { asError, linesAnswer } from './reply.mjs'
import { foreignBareIssueWarnings, itemState, publicTextProblems } from './rules.mjs'
import { forgetThread } from './threads.mjs'
import { plural } from './util.mjs'
import { privateWords } from './words-tools.mjs'

const HOW = 'tick it, name the issue or pull request that carries it (#N), or add "dropped: <why>" to it'

/**
 * The items an issue's body plans, then those of each plan section it cites, read from the default branch; the citations that did
 * not read (`unread`), and the plans it names with no section, whose items are not read (`bare`, a warning).
 */
export async function issueItems(repo, body) {
  const items = planItems(body)
  const unread = []
  const { sections, bare } = citedPlans(body)
  const named = bare.map((f) => `${PLANS}/${f}, which the issue names without a section, was not read: cite the section that lists its work (${f} §n) to have it checked.`)
  if (!sections.length) return { items, unread, bare: named }
  const { defaultBranch } = await readRepo(repo)
  for (const { file, section } of sections) {
    const path = `${PLANS}/${file}`
    const text = await readRepoFile(repo, path, defaultBranch)
    const part = text === null ? null : planSection(text, section)
    if (part === null) unread.push(`${path} ${section}, which the issue cites, is not on ${defaultBranch}${text === null ? '' : ' (no heading of that section)'}`)
    else items.push(...planItems(part, `${path} ${section}`))
  }
  return { items, unread, bare: named }
}

const cut = (text) => (text.length > 100 ? `${text.slice(0, 99)}…` : text)
const itemLine = (item, n) => `item ${n}: "${cut(item.text)}" (${item.where})`

/**
 * The open issues among `issues` (as closedIssues names them) that plan items gone nowhere: a problem for each, which says how
 * to account for them or leave the issue open. An issue or a plan that does not read is a warning; an outage is thrown, as for any read.
 */
export async function itemsLeftProblems(repo, issues, what) {
  const problems = []
  const warnings = []
  for (const name of issues) {
    const want = itemOf(name, repo)
    let issue
    let read
    try {
      issue = await readIssue(want.repo, want.number)
      read = issue.pull || issue.state !== 'OPEN' ? null : await issueItems(want.repo, issue.body)
    } catch (e) {
      if (!ownFailure(e)) throw e
      warnings.push(`${want.ref}, which ${what} closes, could not be read, so its planned items were not checked: ${e.message}`)
      continue
    }
    if (!read) continue
    warnings.push(...read.unread.map((u) => `${u}: its items were not checked.`), ...read.bare)
    const open = read.items.map((item, i) => ({ item, n: i + 1 })).filter((x) => !x.item.state)
    if (!open.length) continue
    const shown = open.slice(0, 5).map((x) => itemLine(x.item, x.n))
    problems.push(
      `${what} closes ${want.ref}, which plans ${plural(open.length, 'item')} not built, carried or dropped (${shown.join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''}). For each, in ${want.ref}: ${HOW} (this pull request's number, for what it builds); or write "None: part of ${want.ref}" under Closes, and close ${want.ref} with close_issue once the rest is done.`,
    )
  }
  return { problems, warnings }
}

const REASONS = { completed: 'completed', 'not planned': 'not_planned' }

/** What the closing comment says of each item: where it went, as `items` gives it or as the issue says. */
function itemRecord(item, n, given) {
  const to = given ?? (item.state === 'ticked' ? 'done (ticked)' : 'as the item says')
  return `- Item ${n}, "${cut(item.text)}": ${to}`
}

async function closeIssueChecked({ item, comment, reason = 'completed', items: givenItems = {}, dryRun }) {
  const want = itemOf(item)
  const words = await privateWords()
  const said = String(comment ?? '').trim()
  const problems = said ? publicTextProblems(said, words, 'The comment') : ['The comment is empty: say what was built and where, or why it is not planned.']
  const issue = await readIssue(want.repo, want.number)
  if (issue.pull) throw new GitHubError('input', `${want.ref} is a pull request; close_issue closes issues (a pull request closes when it lands, or with gh pr close).`)
  if (issue.state !== 'OPEN') throw new GitHubError('input', `${want.ref} is closed already; nothing was sent to GitHub.`)
  const { items, unread, bare } = await issueItems(want.repo, issue.body)
  // A citation that does not read would close the issue with its plan unchecked: the issue's citation is fixed first
  problems.push(...unread.map((u) => `${u}: correct the citation in ${want.ref}, or take it out if the plan is not its plan.`))
  const given = new Map()
  for (const [k, to] of Object.entries(givenItems)) {
    const n = /^[1-9]\d*$/.test(k) ? Number(k) : NaN
    if (!(n <= items.length)) problems.push(`items names "${k}", and ${want.ref} has ${items.length ? `items 1 to ${items.length}` : 'no planned items'}.`)
    else if (!itemState(to)) problems.push(`items.${k} ("${cut(String(to))}") names no issue or pull request (#N) and does not say "dropped: <why>".`)
    else {
      given.set(n, to)
      problems.push(...publicTextProblems(to, words, `items.${k}`))
    }
  }
  // Not planned too: an item left is dropped only with its own reason, or switching the reason would get past this
  const open = items.map((x, i) => ({ item: x, n: i + 1 })).filter((x) => !x.item.state && !given.has(x.n))
  if (open.length)
    problems.push(`${want.ref} plans ${plural(open.length, 'item')} not built, carried or dropped. For each, in ${want.ref}: ${HOW}; or give items: { "<n>": "#N" or "dropped: <why>" }, which the closing comment records.`)
  if (problems.length)
    return asError(
      linesAnswer(`Not closed: ${problems.length === 1 ? 'one rule fails' : `${problems.length} rules fail`}; nothing was sent to GitHub.`, [['problems', '', problems], ['open', 'Items left:', open.map((x) => itemLine(x.item, x.n))]], { ok: false, open: open.map((x) => ({ n: x.n, text: x.item.text, where: x.item.where })) }),
    )
  const record = items.map((x, i) => itemRecord(x, i + 1, given.get(i + 1)))
  const body = record.length ? `${said}\n\nPlanned items (${items.length}):\n${record.join('\n')}` : said
  const warnings = [...bare, ...foreignBareIssueWarnings(body, want.repo, 'The comment')]
  if (dryRun) return linesAnswer(`Ready to close ${want.ref} as ${reason} (dry run, nothing sent). The comment:`, [['body', '', [body]], ['warnings', 'Warnings:', warnings]], { ok: true, body })
  // The record first, so a closed issue always says where its items went; a close that fails after it leaves the issue open, and closing again posts a second record
  let c
  try {
    c = await postComment(want.repo, want.number, body)
    await setIssueClosed(want.repo, want.number, REASONS[reason])
  } finally {
    forgetThread(want.repo, want.number)
    forget()
  }
  return linesAnswer(`Closed ${want.ref} as ${reason}${record.length ? `, with where each of its ${plural(items.length, 'planned item')} went` : ''}: ${c.url ?? ''}`.trim(), [['warnings', 'Warnings:', warnings]], { ok: true, ref: want.ref, comment: c.url ?? null })
}

export const tools = {
  close_issue: {
    config: {
      title: 'Close an issue whose planned items all went somewhere',
      description:
        'Instead of gh issue close: close an issue with a comment saying what was built and where. Refused, with nothing sent, while an item it plans went nowhere: a task-list box, or under a heading of work (proposal, to do, steps, fix, pull requests, follow-ups, later; not options to pick from) a numbered line or a numbered row of a table whose first column is #, Step, Unit or PR; in its body, and in a plan section it cites (docs/plans/<name>.md §n, #anchor or "Heading", read from the default branch; refused when that does not read; a plan named without a section is a warning). An item went somewhere when it is ticked, names an issue or pull request (#N), or says "dropped: <why>" in the issue, or when items gives it "#N" or "dropped: <why>"; as much when closing as not planned. The refusal lists the items left by number. The comment lists every planned item and where it went. dryRun answers the comment without closing.',
      inputSchema: z.object({
        item: itemInput,
        comment: z.string().max(20000).describe('What was built and where (the pull requests), or why it is not planned; in English'),
        reason: z.enum(['completed', 'not planned']).optional().describe('Default "completed"'),
        items: z.record(z.string(), z.string().max(2000)).optional().describe('Where items the issue does not account for went, by the number the refusal gives: { "2": "#2510" } or { "2": "dropped: <why>" }'),
        dryRun: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: serially(answering(closeIssueChecked, 'Not closed: ')),
  },
}
