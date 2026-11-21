// The contribution procedure: comment, edit_comment, file_issue, open_pr, pre_pr, commit_check, rebase_stack.
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { commentIdOf } from './answers.mjs'
import { checkoutDir, itemInput, itemOf, itemRef, pathInput, REF_HELP, refOf, repoInput, repoOf } from './board.mjs'
import { config } from './config.mjs'
import { GitError } from './git.mjs'
import { addLabels, createIssue, createPr, editComment, FATAL, GitHubError, markDraft, openPrsOnBase, postComment, postStatus, prsWithHead, QUEUE_PR_FIELDS, readComment, readPr, readRepo, readRepoFile, readStatus, sameRepo, setPrBase, viewerLogin } from './github.mjs'
import { progress } from './ci-tools.mjs'
import { answering, serially } from './handlers.mjs'
import { renderMarkdown } from './markdown.mjs'
import { noteOpened } from './opened.mjs'
import { PRE_PR_STATUS, prePrDescription, runPrePr } from './pre-pr.mjs'
import { answer, asError, linesAnswer } from './reply.mjs'
import { CLOSES_HEADING, commitProblems, DEFAULT_CONVENTIONS, fillTemplate, foreignBareIssueWarnings, parseConventions, publicTextProblems, subjectProblems } from './rules.mjs'
import { rebaseStack, StackRefusal } from './stack.mjs'
import { forgetThread } from './threads.mjs'
import { privateWords } from './words-tools.mjs'
import { ACTIVE, longSubject, longSubjectText } from './queue.mjs'
import { readQueue } from './queue-driver.mjs'
import { freshCache } from './cache.mjs'
import { labelTier } from './queue-integrate.mjs'
import { short } from './util.mjs'

// --- The contribution procedure: public text, pull requests, commits, stacks (#386 step 2) ----------
// The rules come from the repository (the pull request template, the commit conventions) and the
// private word list from this app's data folder. Each tool refuses with the reasons and writes
// nothing when a rule fails; the checks run before the first call that changes anything on GitHub.

/** What keeps a comment off GitHub: the public text rules, or that it is empty. */
const commentProblems = async (body) => (String(body ?? '').trim() ? publicTextProblems(body, await privateWords(), 'The comment') : ['The comment is empty.'])

/**
 * Posts an agent's comment (the `comment` tool): not empty, in English, no word from the private list,
 * no attribution line. The owner's own answers never come through here: the screen saves them on
 * this machine (`save_answer`), and an agent records the decision in English (owner decision,
 * 2026-10-12: the repository is public).
 */
async function postItemComment({ item, body }) {
  const want = itemOf(item)
  const ref = want.ref
  const problems = await commentProblems(body)
  if (problems.length) throw new GitHubError('input', `Not posted on ${ref}: ${problems.join(' ')}`)
  const warnings = foreignBareIssueWarnings(body, want.repo, 'The comment')
  let c
  try {
    c = await postComment(want.repo, want.number, body)
  } finally {
    // Whether or not it went through, the cached thread can no longer be trusted
    forgetThread(want.repo, want.number)
  }
  const base = `https://github.com/${want.repo}/issues/${want.number}`
  return linesAnswer(`Posted a comment on ${ref}${c.url ? `: ${c.url}` : ''}.`, [['warnings', 'Warnings:', warnings]], {
    ok: true,
    ref,
    comment: { id: c.id, url: c.url, author: c.author, createdAt: c.createdAt, html: renderMarkdown(c.body, { repo: want.repo, base }) },
    ...(warnings.length ? { warnings } : {}),
  })
}

/** Edits only a comment belonging to the account gh is using, after all public-text checks pass. */
async function editItemComment({ item, url, body }) {
  const want = itemOf(item)
  const ref = want.ref
  const id = commentIdOf(url, want.repo, want.number)
  if (id.problem) throw new GitHubError('input', `Not edited: ${id.problem}`)
  const problems = await commentProblems(body)
  if (problems.length) throw new GitHubError('input', `Not edited on ${ref}: ${problems.join(' ')}`)
  const [before, me] = await Promise.all([readComment(want.repo, id.id), viewerLogin()])
  if (!before || before.number !== want.number) throw new GitHubError('input', `Not edited: GitHub has no comment ${id.id} on ${ref}.`)
  if (String(before.author).toLowerCase() !== String(me).toLowerCase()) throw new GitHubError('input', `Not edited: comment ${id.id} belongs to ${before.author}, not the gh account ${me}.`)
  let c
  try {
    c = await editComment(want.repo, id.id, body)
  } finally {
    // As for a post: an edit cut off on the way back may have landed, so the cached thread goes either way
    forgetThread(want.repo, want.number)
  }
  const warnings = foreignBareIssueWarnings(body, want.repo, 'The comment')
  return linesAnswer(`Edited your comment on ${ref}${c.url ? `: ${c.url}` : ''}.`, [['warnings', 'Warnings:', warnings]], { ok: true, ref, comment: c })
}

// Where GitHub looks for a pull request template; project.json can name the one to use
const PR_TEMPLATES = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/PULL_REQUEST_TEMPLATE.md']
const RULES = {
  prTemplates: config.rules?.prTemplate ? [config.rules.prTemplate, ...PR_TEMPLATES.filter((p) => p !== config.rules.prTemplate)] : PR_TEMPLATES,
  commitConventions: config.rules?.commitConventions ?? 'docs/commit-conventions.md',
}
const ruleFiles = freshCache({ ttlMs: 10 * 60_000, max: 50 }) // `${repo} ${path} ${ref}` → the text

/** A rules file from the repository on GitHub, kept 10 minutes; null when the repository has none. */
const ruleFile = (repo, path, ref) => ruleFiles.get(`${repo.toLowerCase()} ${path} ${ref}`, () => readRepoFile(repo, path, ref))

/** The commit conventions of `repo` (its default branch), or the usual ones with a note why. */
async function conventionsOf(repo) {
  const { defaultBranch } = await readRepo(repo)
  const text = await ruleFile(repo, RULES.commitConventions, defaultBranch)
  if (text === null) return { conventions: DEFAULT_CONVENTIONS, source: `the usual Conventional Commits rules (${repo} has no ${RULES.commitConventions})` }
  return { conventions: parseConventions(text), source: RULES.commitConventions }
}

/** Refuses with every problem at once; warnings go along with a success. */
const refusal = (prefix, problems, extra = {}) =>
  asError(linesAnswer(`${prefix} ${problems.length === 1 ? 'One rule fails' : `${problems.length} rules fail`}; nothing was sent to GitHub.`, [['problems', '', problems]], { ok: false, ...extra }))

async function commitCheck({ message, messages, repo }) {
  const list = messages ?? (message !== undefined ? [message] : null)
  if (!list?.length) throw new GitHubError('input', 'Give message (one commit message) or messages (several).')
  const r = repoOf(repo)
  const { conventions, source } = await conventionsOf(r)
  const privateList = await privateWords()
  const results = list.map((m) => ({ subject: String(m).split('\n')[0], ...commitProblems(m, conventions, privateList) }))
  const bad = results.filter((x) => x.problems.length)
  const lines = results.flatMap((x, n) => {
    const head = `${list.length > 1 ? `${n + 1}. ` : ''}"${x.subject}": ${x.problems.length ? 'refused' : 'ok'}`
    return [head, ...x.problems.map((p) => `  ${p}`), ...x.warnings.map((w) => `  (warning) ${w}`)]
  })
  const summary = bad.length ? `${bad.length} of ${list.length} refused by ${source}.` : `${list.length === 1 ? 'The message follows' : `All ${list.length} follow`} ${source}.`
  const a = linesAnswer(summary, [['results', '', lines]], { ok: bad.length === 0 })
  return bad.length ? asError(a) : a
}

const SKIPPED_TIER_LINE = 'Tier: deep (pnpm pre-pr was not run, so the paths were not judged).'

const PR_SECTIONS = { why: 'Why', whatChanged: 'What changed', verified: 'Verified', situationsChecked: 'Situations checked', usability: 'Usability', notExercised: 'Not exercised', closes: CLOSES_HEADING }

export async function openPr({ title, head, base, draft, repo, sections, dryRun, verifiedNote, labels = [], status = null, alsoWarn = [], signal, ...named }) {
  const r = repoOf(repo)
  const info = await readRepo(r)
  const target = base ?? info.defaultBranch
  let template = null
  for (const path of RULES.prTemplates) if ((template = await ruleFile(r, path, target)) !== null) break
  if (template === null) throw new GitHubError('setup', `${r} has no pull request template on ${target} to fill (looked for ${RULES.prTemplates.join(', ')}). Nothing was opened.`)
  const given = { ...sections }
  for (const [k, heading] of Object.entries(PR_SECTIONS)) if (named[k] !== undefined) given[heading] = named[k]
  // What pnpm pre-pr said (or why it did not run) goes under Verified, where a reviewer reads what was run
  if (verifiedNote) {
    const key = Object.keys(given).find((k) => k.trim().toLowerCase() === 'verified') ?? 'Verified'
    given[key] = [String(given[key] ?? '').trim(), verifiedNote].filter(Boolean).join('\n\n')
  }
  const filled = fillTemplate(template, given)
  const { conventions } = await conventionsOf(r)
  const subject = subjectProblems(title, conventions)
  const list = await privateWords()
  const problems = [...subject.problems.map((p) => `Title: ${p}`), ...filled.problems, ...publicTextProblems(title, list, 'The title'), ...publicTextProblems(filled.body, list, 'The description')]
  const warnings = [...subject.warnings.map((w) => `Title: ${w}`), ...filled.warnings]
  // The squash commit's subject is "Title (#N)" (the queue's squash) and has to fit, as queue_merge says it: a pull request number has four digits by now
  const long = longSubject({ number: 9999, title, body: '' })
  if (long) problems.push(longSubjectText(long))
  warnings.push(...alsoWarn)
  if (problems.length) return refusal('Not opened:', problems, { warnings })
  // Stacked on another pull request: that one is a lower now, and a stack's lowers are drafts (#1066)
  const lower = target === info.defaultBranch ? null : ((await prsWithHead(r, target)).find((p) => p.state === 'OPEN') ?? null)
  // One the merge queue holds lands as itself, and the queue never merges a draft it did not make: it stays ready (#1673)
  const queued = lower && !lower.isDraft && inQueue(r, lower.number)
  const lowerLine = (done) =>
    queued
      ? `${refOf(r, lower.number)}, which this one is stacked on, is in the merge queue, so it stays ready and lands on its own; once it has, move this one onto ${info.defaultBranch} with rebase_stack.`
      : `${done ? 'Turned' : 'Would turn'} ${refOf(r, lower.number)}, which this one is stacked on, into a draft: a stack's lower pull requests run no CI, since its top's run and the merge queue's batch prove the stack (CONTRIBUTING.md).`
  if (dryRun)
    return linesAnswer(`Ready to open "${title}" from ${head} into ${target}${draft ? ' as a draft' : ''} (dry run, nothing sent).${lower && !lower.isDraft ? ` ${lowerLine(false)}` : ''}`, [['warnings', 'Warnings:', warnings]], { ok: true, body: filled.body })
  // A call cancelled while it waited for its turn opens nothing
  if (signal?.aborted) throw new GitHubError('input', 'the call was cancelled; nothing was sent to GitHub.')
  const pr = await createPr(r, { title, head, base: target, body: filled.body, draft })
  // Which session opened it (opened.mjs): the merge queue marks a draft ready when that session queues it, and posts a conflict to it
  try {
    noteOpened(centralu.dataDir, { repo: r, number: pr.number, notice: centralu.noticeAddress(), draft: draft === true })
  } catch (e) {
    console.error(`[project-board] open_pr: could not note which session opened ${refOf(r, pr.number)}: ${e?.message ?? e}`)
  }
  // The tier label (#1259): the pull request is open either way, so any failure here is a warning beside its number
  let labelled = ''
  if (labels.length) {
    try {
      await addLabels(r, pr.number, labels)
      labelled = ` Labelled ${labels.join(', ')}.`
    } catch (e) {
      warnings.push(`${e?.message ?? e} Add the label yourself: gh pr edit ${pr.number} --add-label ${labels.join(',')}.`)
    }
  }
  // The pre-pr status (#1886): on the head pre-pr ran on, or on the head opened when it was skipped
  if (status) {
    const sha = status.sha ?? pr.head
    try {
      if (!sha) throw new GitHubError('github', 'GitHub gave no head commit for it.')
      await postStatus(r, sha, { state: 'success', context: PRE_PR_STATUS, description: status.description })
    } catch (e) {
      warnings.push(`The pre-pr status was not posted: ${e?.message ?? e} queue_merge asks for it; run pre_pr on ${refOf(r, pr.number)}, which posts it.`)
    }
  }
  let stacked = queued ? ` ${lowerLine(false)}` : ''
  if (lower && !lower.isDraft && !queued) {
    try {
      await markDraft(r, lower.number)
      stacked = ` ${lowerLine(true)}`
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      warnings.push(`${e.message} Turn it into a draft yourself (gh pr ready ${lower.number} --undo): a lower runs no CI as a draft.`)
    }
  }
  return linesAnswer(`Opened ${refOf(r, pr.number)} "${title}" from ${head} into ${target}${draft ? ' as a draft' : ''}: ${pr.url}${labelled}${stacked}`, [['warnings', 'Warnings:', warnings]], { ok: true, number: pr.number, url: pr.url, ...(labelled ? { labels } : {}), ...(stacked && !queued ? { drafted: lower.number } : {}) })
}

/** Whether this machine's merge queue holds the pull request: as itself, a stack's top, or one of the lowers under a top (#2098); a queue file that does not read holds nothing. */
function inQueue(repo, number) {
  try {
    return readQueue(centralu.dataDir).items.some((i) => ACTIVE.has(i.state) && String(i.repo).toLowerCase() === String(repo).toLowerCase() && (i.pr === number || (i.lowers ?? []).includes(number)))
  } catch {
    return false
  }
}

/** The branches of the open pull requests under `base`, oldest first: the rest of the stack. */
async function lowerBranches(repo, base, defaultBranch) {
  const chain = []
  let branch = base
  for (let i = 0; i < 20 && branch && branch !== defaultBranch && !chain.includes(branch); i++) {
    const below = (await prsWithHead(repo, branch)).find((p) => p.state === 'OPEN')
    if (!below) break
    chain.unshift(branch)
    branch = below.baseRefName
  }
  return chain
}

/**
 * pnpm pre-pr on the pushed `head` and the branches of the open pull requests under `base` (#1181), or its skip with a reason:
 * what open_pr and pre_pr write from it. Runs outside the one-write-at-a-time line, so other writes do not wait minutes behind
 * it. Answers `{ refused }`, an answer of what pre-pr found that starts with `refusal`, or `{ note, tier, warnings, sha, description }`: the Verified
 * note, the tier, and the pre-pr status (`sha` null when skipped: the caller's head is the one).
 */
async function checkHead({ repo, head, fork, base, path, skipPrePr, prePrExempt, refusal }, ctx) {
  const signal = ctx?.mcpReq?.signal
  const cancelled = () => {
    if (signal?.aborted) throw new GitHubError('input', 'the call was cancelled; nothing was sent to GitHub.')
  }
  const exempt = Object.fromEntries(Object.entries(prePrExempt ?? {}).map(([check, why]) => [check, String(why ?? '').trim()]))
  for (const [check, why] of Object.entries(exempt)) if (!why) throw new GitHubError('input', `prePrExempt.${check} needs the reason that check is left out; it goes into the description.`)
  if (skipPrePr !== undefined) {
    const why = String(skipPrePr).trim()
    if (!why) throw new GitHubError('input', 'skipPrePr needs the reason the checks are skipped; it goes into the description.')
    // Not run, the paths were not judged: deep, so skipping pre-pr never lowers the review (#1259)
    return { note: `\`pnpm pre-pr\` was not run: ${why}\n${SKIPPED_TIER_LINE}`, tier: 'deep', warnings: [], sha: null, description: prePrDescription('deep', `skipped: ${why}`) }
  }
  if (fork) throw new GitHubError('input', `pnpm pre-pr cannot fetch a fork's branch (${head}) here. Run it in that checkout, and give skipPrePr with what it said.`)
  const dir = await checkoutDir(path)
  const info = await readRepo(repo)
  const target = base ?? info.defaultBranch
  const lowers = await lowerBranches(repo, target, info.defaultBranch)
  cancelled()
  progress(ctx, 0, `pnpm pre-pr on ${head}${lowers.length ? ` and the ${lowers.length} pull request(s) under it` : ''}`)
  const res = await runPrePr({
    dir,
    repo,
    head,
    base: target,
    main: info.defaultBranch,
    lowers,
    exempt,
    script: config.rules?.prePr ?? 'scripts/pre-pr.mjs',
    beat: (seconds) => progress(ctx, seconds, `pnpm pre-pr on ${head}: ${seconds} s so far`),
    signal,
  })
  const warnings = res.refsLeft.map((l) => `A ref of pre-pr's was left behind: ${l}.`)
  cancelled()
  if (!res.ran) throw new GitHubError('input', `pnpm pre-pr did not run: ${res.why.replace(/\.?$/, '.')} Give path (a checkout of ${repo}), or skipPrePr with the reason it cannot run.${warnings.length ? ` ${warnings.join(' ')}` : ''}`)
  if (!res.ok) {
    const found = res.findings.map((f) => `[${f.check}] ${f.message}`)
    return {
      refused: asError(
        linesAnswer(
          `${refusal} pnpm pre-pr found ${found.length} problem(s) on ${head}; nothing was sent to GitHub. Fix them and push, or give prePrExempt (one check) or skipPrePr (all) with the reason they stand.`,
          [['findings', '', found], ['warnings', 'Warnings:', [...res.warnings.map((w) => `[${w.check}] ${w.message}`), ...warnings]], ['notes', 'Notes:', res.notes]],
          { ok: false, prePr: { findings: res.findings, warnings: res.warnings, notes: res.notes } },
        ),
      ),
    }
  }
  const note = [
    `\`pnpm pre-pr\` passed at ${String(res.head ?? '').slice(0, 10)}${res.passed.length ? `: ${res.passed.join(', ')}` : ''}.`,
    ...res.exempted.map((x) => `Not run, the ${x.check} check: ${x.reason}`),
    ...res.warnings.map((w) => `Warning (${w.check}): ${w.message}`),
    // The risk tier by the paths changed (#1259): a line in Verified, and the label the merge queue reads
    res.tier.line,
  ].join('\n')
  warnings.push(...res.warnings.map((w) => `[${w.check}] ${w.message}`))
  const how = res.exempted.length ? `passed without ${res.exempted.map((x) => x.check).join(', ')}` : 'passed'
  return { note, tier: res.tier.name, warnings, sha: res.head, description: prePrDescription(res.tier.name, how) }
}

/**
 * open_pr: the template and title rules first (cheap, and a wrong title is not learned after minutes), then pnpm pre-pr
 * (checkHead), then the pull request, with pre-pr's tier as a label and its status on the head. pre-pr's findings refuse it.
 */
async function openPrChecked({ skipPrePr, prePrExempt, path, ...args }, ctx) {
  if (args.dryRun) {
    const dry = await openPr(args)
    return dry.isError || skipPrePr !== undefined ? dry : { ...dry, content: [{ type: 'text', text: `${dry.content[0].text}\npnpm pre-pr runs when it opens (or give skipPrePr, or prePrExempt for one check, with the reason).` }] }
  }
  const dry = await openPr({ ...args, dryRun: true })
  if (dry.isError) return dry
  const c = await checkHead({ repo: repoOf(args.repo), head: args.head, fork: String(args.head).includes(':'), base: args.base, path, skipPrePr, prePrExempt, refusal: 'Not opened:' }, ctx)
  if (c.refused) return c.refused
  return serially(openPr)({ ...args, verifiedNote: c.note, labels: [`tier:${c.tier}`], status: c, alsoWarn: c.warnings, signal: ctx?.mcpReq?.signal }, ctx)
}

/**
 * pre_pr (#1886): pnpm pre-pr on an open pull request's head as it is now (checkHead), for a head pushed after open_pr, then
 * the pre-pr status on it, and its tier label raised when the paths now call for more (a label only raises: labelTier).
 */
async function prePrOn({ pr, path, skipPrePr, prePrExempt }, ctx) {
  const want = itemOf(pr)
  const p = await readPr(want.repo, want.number, QUEUE_PR_FIELDS)
  if (p.state !== 'OPEN') throw new GitHubError('input', `${want.ref} is ${String(p.state).toLowerCase()}; pre_pr checks an open pull request.`)
  const c = await checkHead({ repo: want.repo, head: p.headRefName, fork: p.isCrossRepository, base: p.baseRefName, path, skipPrePr, prePrExempt, refusal: `No pre-pr status on ${want.ref}:` }, ctx)
  if (c.refused) return c.refused
  return serially(postPrePr)({ want, p, c }, ctx)
}

async function postPrePr({ want, p, c }) {
  const sha = c.sha ?? p.headRefOid
  const warnings = [...c.warnings]
  await postStatus(want.repo, sha, { state: 'success', context: PRE_PR_STATUS, description: c.description })
  if (sha !== p.headRefOid) warnings.push(`${want.ref} was at ${short(p.headRefOid)} when read, and pre-pr ran on ${short(sha)}: the branch moved meanwhile. The status is on ${short(sha)}; run pre_pr again if that is not its head now.`)
  const had = labelTier(p.labels)
  const tier = labelTier([...(p.labels ?? []), `tier:${c.tier}`])
  let labelled = ''
  if (tier !== had) {
    try {
      await addLabels(want.repo, want.number, [`tier:${tier}`])
      labelled = ` Labelled tier:${tier}${had ? `, above its tier:${had}` : ''}.`
    } catch (e) {
      warnings.push(`${e?.message ?? e} Add the label yourself: gh pr edit ${want.number} --add-label tier:${tier}.`)
    }
  } else if (c.tier !== had) labelled = ` Its label stays tier:${had}: a label only raises, so take it off by hand if the paths now ask for less.`
  const done = c.sha ? `pnpm pre-pr passed on ${want.ref} at ${short(sha)}` : `pnpm pre-pr skipped for ${want.ref} at ${short(sha)}`
  return linesAnswer(`${done}; posted the pre-pr status (${c.description}).${labelled}`, [['warnings', 'Warnings:', warnings]], { ok: true, head: sha, tier: c.tier, note: c.note })
}

async function fileIssue({ title, body, labels, repo, dryRun }) {
  const r = repoOf(repo)
  const list = await privateWords()
  const problems = [...(String(title ?? '').trim() ? [] : ['The title is empty.']), ...publicTextProblems(title, list, 'The title'), ...publicTextProblems(body, list, 'The body')]
  const warnings = foreignBareIssueWarnings(body, r, 'The body')
  if (problems.length) return refusal('Not filed:', problems)
  if (dryRun) return linesAnswer(`Ready to file "${title}" on ${r} (dry run, nothing sent).`, [['warnings', 'Warnings:', warnings]], { ok: true })
  const issue = await createIssue(r, { title, body, labels })
  return linesAnswer(`Filed ${refOf(r, issue.number)} "${title}": ${issue.url}`, [['warnings', 'Warnings:', warnings]], { ok: true, number: issue.number, url: issue.url })
}


/**
 * The pre-pr status of `from` posted on `to`, its restack (#1886): rebase_stack pushes only a replay with the same patch id,
 * so what pre-pr said of the change holds. Answers the line that says what was done; the push stands either way.
 */
async function carryPrePr(repo, from, to) {
  try {
    const s = await readStatus(repo, from, PRE_PR_STATUS)
    if (s?.state !== 'success') return `${short(from)} had no pre-pr status to carry over to ${short(to)}: run pre_pr on it before queue_merge.`
    await postStatus(repo, to, { state: 'success', context: PRE_PR_STATUS, description: `carried from ${short(from)} by rebase_stack; ${s.description}` })
    return `Carried the pre-pr status of ${short(from)} over to ${short(to)}: the same change.`
  } catch (e) {
    return `The pre-pr status of ${short(from)} was not carried over to ${short(to)}: ${e?.message ?? e} Run pre_pr on it before queue_merge.`
  }
}

async function restack({ pr, lower, path, push }) {
  const want = itemOf(pr)
  const below = lower === undefined ? undefined : itemOf(lower, want.repo)
  if (below && !sameRepo(below.repo, want.repo)) throw new GitHubError('input', 'lower must be a pull request of the same repository.')
  try {
    const r = await rebaseStack(
      { repo: want.repo, pr: want.number, lower: below?.number, dir: await checkoutDir(path), push: push === true },
      { readPr, prsWithHead, setPrBase, openPrsOnBase, carry: (from, to) => carryPrePr(want.repo, from, to) },
      (n) => refOf(want.repo, n),
    )
    return linesAnswer(r.summary, [['steps', '', r.lines]], { ok: !r.partial, pushed: r.pushed, head: r.rebased, sameTree: r.sameTree })
  } catch (e) {
    if (e instanceof StackRefusal || e instanceof GitError) return asError(answer(`Not restacked: ${e.message}`, { ok: false, pushed: false }))
    throw e
  }
}

/** What open_pr and pre_pr take to leave pre-pr's checks out */
const PRE_PR_INPUT = {
  skipPrePr: z.string().max(2000).optional().describe('Without running pnpm pre-pr at all: the reason, which goes into Verified and the pre-pr status'),
  prePrExempt: z.object({ tsc: z.string().max(2000), orphans: z.string().max(2000), deps: z.string().max(2000), lint: z.string().max(2000), 'repo-guards': z.string().max(2000), 'store-step': z.string().max(2000), guards: z.string().max(2000), revert: z.string().max(2000) }).partial().strict().optional().describe('Leave one of pnpm pre-pr\'s checks out, by name, with the reason (it goes into Verified): e.g. { "revert": "the new test guards a Windows path this branch only documents" }'),
}

export const tools = {
  comment: {
    config: {
      title: 'Comment on an issue or pull request',
      description:
        'Instead of gh pr comment / gh issue comment: post a comment on an issue or pull request on GitHub, as the gh login. Refused, with nothing posted, when it is empty, not in English (code and > quotes aside), holds a word from the private list, or carries an attribution line (Co-Authored-By, "Generated with"). Answers the comment as GitHub stored it.',
      inputSchema: z.object({ item: itemInput, body: z.string().max(65536).describe('The comment, in Markdown') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', ui: { visibility: ['model'] } },
    },
    handler: serially(answering(postItemComment)),
  },

  edit_comment: {
    config: {
      title: 'Edit your comment',
      description: 'Replace a comment only when it belongs to the gh login. Uses the same English, private-word and attribution checks as comment.',
      inputSchema: z.object({ item: itemInput, url: z.string().describe('The comment address on this item'), body: z.string().max(65536).describe('Replacement Markdown') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: serially(answering(editItemComment)),
  },

  file_issue: {
    config: {
      title: 'File an issue',
      description:
        "Instead of gh issue create: file an issue on this project's repository (or repo). Refused, with nothing filed, when the title is empty or the title or body is not in English (code and > quotes aside), holds a word from the private list, or carries an attribution line. dryRun checks only.",
      inputSchema: z.object({
        title: z.string().max(256),
        body: z.string().max(65536).describe('The issue, in Markdown'),
        labels: z.array(z.string()).max(20).optional().describe('Labels; GitHub applies them only for a login that may'),
        repo: repoInput,
        dryRun: z.boolean().optional().describe('Check without filing'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', ui: { visibility: ['model'] } },
    },
    handler: serially(answering(fileIssue, 'Not filed: ')),
  },

  open_pr: {
    config: {
      title: 'Open a pull request from the template',
      description:
        "Instead of gh pr create: run the repository's pnpm pre-pr on the pushed head (lint on the changed files, tsc at every head of its stack, orphans and the other dependency-cruiser errors, the fast repository-wide guards, a store step number main or another open pull request already uses, repository-wide guards run against the open pull requests (a warning), new tests that pass without the change, main merged in; it stops at the first check that finds something) and refuse with what it finds (a branch behind main is only a warning), unless prePrExempt leaves one check out or skipPrePr all of them, with the reason; a cancelled call opens nothing; pre-pr's risk tier (scripts/tier.mjs) goes into Verified as a Tier line and onto the pull request as the label tier:<name> (deep when pre-pr is skipped or answers none); then open a pull request with its description filled into the repository's pull request template (read from the base branch): why, whatChanged, verified, situationsChecked, usability, notExercised, closes, or sections keyed by any other heading. A heading left out is dropped, as the template asks, except Not exercised, which must name what was not run (\"Nothing\" when true), and a heading the template says to keep (Situations checked and Usability: the answer, or n/a). Refused, with nothing opened, when the title does not follow docs/commit-conventions.md or its squash subject, \"Title (#NNNN)\", would be over 72 characters (as queue_merge refuses it), a heading is not in the template, or the text is not in English, holds a private word or carries an attribution line. dryRun answers the filled description without opening. Stacked (base is another open pull request's branch), it turns that one into a draft: a stack's lower pull requests are drafts, which run no CI (#1066); one the merge queue holds (as itself, as a stack's top, or as a lower under a queued top) stays ready, as the queue never merges a draft it did not make, and the answer says to restack the new one with rebase_stack once it lands (#1673).",
      inputSchema: z.object({
        title: z.string().max(256).describe('Conventional commit form, e.g. "fix(ui): keep grid focus on the orchestrator"; it becomes the squash subject'),
        head: z.string().min(1).describe('The branch with the changes (owner:branch for a fork), already pushed'),
        base: z.string().optional().describe('The branch to merge into; default the repository default branch'),
        why: z.string().optional(),
        whatChanged: z.string().optional(),
        verified: z.string().optional(),
        situationsChecked: z.string().optional().describe('What the change does on a host swap, link loss and reconnect, an older build reading what it writes, two at once, the person using the same session, and data loss (CONTRIBUTING.md#situations-checked); n/a when it changes no behaviour'),
        usability: z.string().optional().describe('Discoverable-path numbers before and after for a change on screen, else "n/a" (docs/usability.md)'),
        notExercised: z.string().optional().describe('Surfaces this change touches that were not run; required'),
        closes: z.string().optional().describe('e.g. "Closes #386", or why there is no issue'),
        sections: z.record(z.string(), z.string()).optional().describe('Any heading of the template by its name, e.g. { "Screenshots": "…" }'),
        ...PRE_PR_INPUT,
        path: pathInput,
        draft: z.boolean().optional(),
        repo: repoInput,
        dryRun: z.boolean().optional().describe('Fill and check without opening'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', 'centralu/askWhen': { path: '*' }, 'centralu/askUnless': { skipPrePr: '*', dryRun: true }, ui: { visibility: ['model'] } },
    },
    handler: answering(openPrChecked, 'Not opened: '),
  },

  pre_pr: {
    config: {
      title: "Run pnpm pre-pr on a pull request's head",
      description:
        "For a head pushed after open_pr (new commits, or a rebase onto main): run the repository's pnpm pre-pr on the open pull request's head as it is now, as open_pr does, and post the pre-pr commit status on it, which queue_merge asks for and the merge queue waits for on a head that moved. The tier label is raised when the paths now call for more (never lowered). Refused, with nothing posted, on what pre-pr finds; prePrExempt and skipPrePr as for open_pr.",
      inputSchema: z.object({ pr: itemRef.describe(`The pull request: ${REF_HELP}`), ...PRE_PR_INPUT, path: pathInput }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', 'centralu/askWhen': { path: '*' }, 'centralu/askUnless': { skipPrePr: '*' }, ui: { visibility: ['model'] } },
    },
    handler: answering(prePrOn, 'No pre-pr status: '),
  },

  commit_check: {
    config: {
      title: 'Check commit messages',
      description:
        "Check one commit message (message) or several (messages) against the repository's docs/commit-conventions.md: <type>(<scope>): <description>, a type from its table, lowercase scope and description, no trailing period, the subject's length, a blank second line. Refuses attribution lines (Co-Authored-By, \"Generated with\"), text not in English and private words. Body lines past the wrap width and a description that reports (\"added\") are warnings.",
      inputSchema: z.object({
        message: z.string().optional().describe('One whole commit message, subject first'),
        messages: z.array(z.string()).max(100).optional().describe('Several, each checked on its own'),
        repo: z.string().optional().describe("owner/name whose conventions apply; default this project's repository"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(commitCheck),
  },

  rebase_stack: {
    config: {
      title: 'Restack a pull request after the one under it was merged',
      description:
        "Instead of git rebase --onto and git push --force by hand: move a stacked pull request (pr) onto its base after the pull request under it (its base branch's pull request, or lower) was squash-merged. Reads both fresh, replays only pr's own commits (after the lower one's last head) onto the lower one's merge commit in a temporary worktree, and confirms the change is the one CI tested and whether the tree is the tested tree. Refuses when the lower one is not merged, pr was built on an older version of it, the replay conflicts, or the change differs. Without push it only reports; push: true pushes with a lease on the head it read and moves the base. Says when pr is a draft nothing is based on any more, which needs marking ready for CI to run.",
      inputSchema: z.object({
        pr: itemRef.describe(`The upper pull request: ${REF_HELP}`),
        lower: itemRef.optional().describe('The pull request it was stacked on, when GitHub already moved its base'),
        path: pathInput,
        push: z.boolean().optional().describe('Push the result and move the base; default false (report only)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', 'centralu/askWhen': { push: true, path: '*' }, ui: { visibility: ['model'] } },
    },
    handler: serially(answering(restack, 'Not restacked: ')),
  },
}
