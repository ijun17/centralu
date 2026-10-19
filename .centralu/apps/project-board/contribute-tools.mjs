// The contribution procedure: comment, edit_comment, file_issue, open_pr, commit_check, rebase_stack.
import { z } from './runtime/centralu-app-runtime.mjs'
import { commentIdOf } from './answers.mjs'
import { itemInput, itemOf, itemRef, pathInput, REF_HELP, refOf, repoInput, repoOf } from './board.mjs'
import { APP_DIR, config } from './config.mjs'
import { GitError } from './git.mjs'
import { addLabels, createIssue, createPr, editComment, FATAL, GitHubError, markDraft, openPrsOnBase, postComment, prsWithHead, readComment, readPr, readRepo, readRepoFile, sameRepo, setPrBase, viewerLogin } from './github.mjs'
import { progress } from './ci-tools.mjs'
import { answering, serially } from './handlers.mjs'
import { renderMarkdown } from './markdown.mjs'
import { runPrePr } from './pre-pr.mjs'
import { answer, asError, linesAnswer } from './reply.mjs'
import { commitProblems, DEFAULT_CONVENTIONS, fillTemplate, foreignBareIssueWarnings, parseConventions, publicTextProblems, subjectProblems } from './rules.mjs'
import { rebaseStack, StackRefusal } from './stack.mjs'
import { forgetThread } from './threads.mjs'
import { privateWords } from './words-tools.mjs'

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
const RULES_TTL_MS = 10 * 60_000
const ruleFiles = new Map() // `${repo} ${path} ${ref}` → { at, text }

/** A rules file from the repository on GitHub, kept 10 minutes; null when the repository has none. */
async function ruleFile(repo, path, ref) {
  const key = `${repo.toLowerCase()} ${path} ${ref}`
  const hit = ruleFiles.get(key)
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.text
  const text = await readRepoFile(repo, path, ref)
  ruleFiles.set(key, { at: Date.now(), text })
  return text
}

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

const PR_SECTIONS = { why: 'Why', whatChanged: 'What changed', verified: 'Verified', situationsChecked: 'Situations checked', usability: 'Usability', notExercised: 'Not exercised', closes: 'Closes' }

export async function openPr({ title, head, base, draft, repo, sections, dryRun, verifiedNote, labels = [], alsoWarn = [], signal, ...named }) {
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
  // The squash commit's subject is "Title (#N)" (merge_when_green): it has to fit too
  const squashLength = [...String(title)].length + ' (#9999)'.length
  if (squashLength > conventions.subjectMax) warnings.push(`Merged, the subject "${title} (#N)" will be about ${squashLength} characters, over ${conventions.subjectMax}.`)
  warnings.push(...alsoWarn)
  if (problems.length) return refusal('Not opened:', problems, { warnings })
  // Stacked on another pull request: that one is a lower now, and a stack's lowers are drafts (#1066)
  const lower = target === info.defaultBranch ? null : ((await prsWithHead(r, target)).find((p) => p.state === 'OPEN') ?? null)
  const lowerLine = (done) => `${done ? 'Turned' : 'Would turn'} ${refOf(r, lower.number)}, which this one is stacked on, into a draft: a stack's lower pull requests run no CI, since its top's run and the merge queue's batch prove the stack (CONTRIBUTING.md).`
  if (dryRun)
    return linesAnswer(`Ready to open "${title}" from ${head} into ${target}${draft ? ' as a draft' : ''} (dry run, nothing sent).${lower && !lower.isDraft ? ` ${lowerLine(false)}` : ''}`, [['warnings', 'Warnings:', warnings]], { ok: true, body: filled.body })
  // A call cancelled while it waited for its turn opens nothing
  if (signal?.aborted) throw new GitHubError('input', 'the call was cancelled; nothing was sent to GitHub.')
  const pr = await createPr(r, { title, head, base: target, body: filled.body, draft })
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
  let stacked = ''
  if (lower && !lower.isDraft) {
    try {
      await markDraft(r, lower.number)
      stacked = ` ${lowerLine(true)}`
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      warnings.push(`${e.message} Turn it into a draft yourself (gh pr ready ${lower.number} --undo): a lower runs no CI as a draft.`)
    }
  }
  return linesAnswer(`Opened ${refOf(r, pr.number)} "${title}" from ${head} into ${target}${draft ? ' as a draft' : ''}: ${pr.url}${labelled}${stacked}`, [['warnings', 'Warnings:', warnings]], { ok: true, number: pr.number, url: pr.url, ...(labelled ? { labels } : {}), ...(stacked ? { drafted: lower.number } : {}) })
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
 * open_pr: the template and title rules first (cheap, and a wrong title is not learned after minutes),
 * then the repository's pnpm pre-pr on the pushed commits (#1181), then the pull request. pre-pr's
 * findings refuse it; `skipPrePr` with a reason opens it anyway and says so in Verified. pre-pr runs
 * outside the one-write-at-a-time line, so other writes do not wait minutes behind it.
 */
async function openPrChecked({ skipPrePr, prePrExempt, path, ...args }, ctx) {
  if (args.dryRun) {
    const dry = await openPr(args)
    return dry.isError || skipPrePr !== undefined ? dry : { ...dry, content: [{ type: 'text', text: `${dry.content[0].text}\npnpm pre-pr runs when it opens (or give skipPrePr, or prePrExempt for one check, with the reason).` }] }
  }
  const signal = ctx?.mcpReq?.signal
  const cancelled = () => {
    if (signal?.aborted) throw new GitHubError('input', 'the call was cancelled; nothing was sent to GitHub.')
  }
  const dry = await openPr({ ...args, dryRun: true })
  if (dry.isError) return dry
  const exempt = Object.fromEntries(Object.entries(prePrExempt ?? {}).map(([check, why]) => [check, String(why ?? '').trim()]))
  for (const [check, why] of Object.entries(exempt)) if (!why) throw new GitHubError('input', `prePrExempt.${check} needs the reason that check is left out; it goes into the description.`)
  let note
  const alsoWarn = []
  const labels = []
  if (skipPrePr !== undefined) {
    const why = String(skipPrePr).trim()
    if (!why) throw new GitHubError('input', 'skipPrePr needs the reason the checks are skipped; it goes into the description.')
    // Not run, the paths were not judged: deep, so skipping pre-pr never lowers the review (#1259)
    note = `\`pnpm pre-pr\` was not run: ${why}\n${SKIPPED_TIER_LINE}`
    labels.push('tier:deep')
  } else {
    if (String(args.head).includes(':')) throw new GitHubError('input', `pnpm pre-pr cannot fetch a fork's branch (${args.head}) here. Run it in that checkout, and give skipPrePr with what it said.`)
    const r = repoOf(args.repo)
    const info = await readRepo(r)
    const target = args.base ?? info.defaultBranch
    const lowers = await lowerBranches(r, target, info.defaultBranch)
    cancelled()
    progress(ctx, 0, `pnpm pre-pr on ${args.head}${lowers.length ? ` and the ${lowers.length} pull request(s) under it` : ''}`)
    const res = await runPrePr({
      dir: path ?? APP_DIR,
      repo: r,
      head: args.head,
      base: target,
      main: info.defaultBranch,
      lowers,
      exempt,
      script: config.rules?.prePr ?? 'scripts/pre-pr.mjs',
      beat: (seconds) => progress(ctx, seconds, `pnpm pre-pr on ${args.head}: ${seconds} s so far`),
      signal,
    })
    alsoWarn.push(...res.refsLeft.map((l) => `A ref of pre-pr's was left behind: ${l}.`))
    cancelled()
    if (!res.ran) throw new GitHubError('input', `pnpm pre-pr did not run: ${res.why.replace(/\.?$/, '.')} Give path (a checkout of ${r}), or skipPrePr with the reason it cannot run.${alsoWarn.length ? ` ${alsoWarn.join(' ')}` : ''}`)
    if (!res.ok) {
      const found = res.findings.map((f) => `[${f.check}] ${f.message}`)
      return asError(
        linesAnswer(
          `Not opened: pnpm pre-pr found ${found.length} problem(s) on ${args.head}; nothing was sent to GitHub. Fix them and push, or give prePrExempt (one check) or skipPrePr (all) with the reason they stand.`,
          [['findings', '', found], ['warnings', 'Warnings:', [...res.warnings.map((w) => `[${w.check}] ${w.message}`), ...alsoWarn]], ['notes', 'Notes:', res.notes]],
          { ok: false, prePr: { findings: res.findings, warnings: res.warnings, notes: res.notes } },
        ),
      )
    }
    const ran = [...(exempt.tsc ? [] : [`tsc at ${res.heads.length} head(s)`]), ...(exempt.orphans ? [] : ['no orphans']), ...(exempt.revert ? [] : ['no new test passes without the change'])]
    note = [
      `\`pnpm pre-pr\` passed at ${String(res.head ?? '').slice(0, 10)}${ran.length ? `: ${ran.join(', ')}` : ''}.`,
      ...res.exempted.map((x) => `Not run, the ${x.check} check: ${x.reason}`),
      ...res.warnings.map((w) => `Warning (${w.check}): ${w.message}`),
      // The risk tier by the paths changed (#1259): a line in Verified, and the label the merge queue reads
      res.tier.line,
    ].join('\n')
    alsoWarn.push(...res.warnings.map((w) => `[${w.check}] ${w.message}`))
    labels.push(`tier:${res.tier.name}`)
  }
  return serially(openPr)({ ...args, verifiedNote: note, labels, alsoWarn, signal }, ctx)
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


async function restack({ pr, lower, path, push }) {
  const want = itemOf(pr)
  const below = lower === undefined ? undefined : itemOf(lower, want.repo)
  if (below && !sameRepo(below.repo, want.repo)) throw new GitHubError('input', 'lower must be a pull request of the same repository.')
  try {
    const r = await rebaseStack(
      { repo: want.repo, pr: want.number, lower: below?.number, dir: path ?? APP_DIR, push: push === true },
      { readPr, prsWithHead, setPrBase, openPrsOnBase },
      (n) => refOf(want.repo, n),
    )
    return linesAnswer(r.summary, [['steps', '', r.lines]], { ok: !r.partial, pushed: r.pushed, head: r.rebased, sameTree: r.sameTree })
  } catch (e) {
    if (e instanceof StackRefusal || e instanceof GitError) return asError(answer(`Not restacked: ${e.message}`, { ok: false, pushed: false }))
    throw e
  }
}

export const tools = {
  comment: {
    config: {
      title: 'Comment on an issue or pull request',
      description:
        'Instead of gh pr comment / gh issue comment: post a comment on an issue or pull request on GitHub, as the gh login. Refused, with nothing posted, when it is empty, not in English (code and > quotes aside), holds a word from the private list, or carries an attribution line (Co-Authored-By, "Generated with"). Answers the comment as GitHub stored it.',
      inputSchema: z.object({ item: itemInput, body: z.string().max(65536).describe('The comment, in Markdown') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
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
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: serially(answering(fileIssue, 'Not filed: ')),
  },

  open_pr: {
    config: {
      title: 'Open a pull request from the template',
      description:
        "Instead of gh pr create: run the repository's pnpm pre-pr on the pushed head (tsc at every head of its stack, orphans, a store step number main or another open pull request already uses, repository-wide guards run against the open pull requests (a warning), new tests that pass without the change, main merged in) and refuse with what it finds (a branch behind main is only a warning), unless prePrExempt leaves one check out or skipPrePr all of them, with the reason; a cancelled call opens nothing; pre-pr's risk tier (scripts/tier.mjs) goes into Verified as a Tier line and onto the pull request as the label tier:<name> (deep when pre-pr is skipped or answers none); then open a pull request with its description filled into the repository's pull request template (read from the base branch): why, whatChanged, verified, situationsChecked, usability, notExercised, closes, or sections keyed by any other heading. A heading left out is dropped, as the template asks, except Not exercised, which must name what was not run (\"Nothing\" when true), and a heading the template says to keep (Situations checked and Usability: the answer, or n/a). Refused, with nothing opened, when the title does not follow docs/commit-conventions.md, a heading is not in the template, or the text is not in English, holds a private word or carries an attribution line. dryRun answers the filled description without opening. Stacked (base is another open pull request's branch), it turns that one into a draft: a stack's lower pull requests are drafts, which run no CI (#1066).",
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
        skipPrePr: z.string().max(2000).optional().describe('Open without running pnpm pre-pr at all: the reason, which goes into Verified'),
        prePrExempt: z.object({ tsc: z.string().max(2000), orphans: z.string().max(2000), 'store-step': z.string().max(2000), guards: z.string().max(2000), revert: z.string().max(2000) }).partial().strict().optional().describe('Leave one of pnpm pre-pr\'s checks out, by name, with the reason (it goes into Verified): e.g. { "revert": "the new test guards a Windows path this branch only documents" }'),
        path: pathInput,
        draft: z.boolean().optional(),
        repo: repoInput,
        dryRun: z.boolean().optional().describe('Fill and check without opening'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(openPrChecked, 'Not opened: '),
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
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: serially(answering(restack, 'Not restacked: ')),
  },
}
