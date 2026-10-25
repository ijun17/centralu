// Everything this app knows about GitHub. It talks to GitHub only through the person's own `gh`
// CLI (`gh api graphql` for the board, `gh api repos/…` and `gh pr` for CI and merging), so the app
// holds no token: gh keeps its login in the system keychain, and
// nothing here reads, stores or prints it. GitHub is the only copy of the board; board.mjs keeps a
// short in-memory cache and nothing on disk.
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { CANCELED_NOTE, LOST_RUNNER_NOTE, shutdownAt } from './run-failure.mjs'
import { mapLimit, short } from './util.mjs'

const GH_TIMEOUT_MS = 30_000
const MAX_PAGES = 20

/** A failure the person can act on. `kind` says which, `message` says what to do, in plain words. */
export class GitHubError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

const SCOPE = /INSUFFICIENT_SCOPES|required scopes|has not been granted the required scope|needs the "(read:)?project" scope/i
// A login that can read the project but not change it (GitHub's GraphQL error type FORBIDDEN, or
// the REST-style wording gh passes on). Not seen live: the owner's own login can always write.
const FORBIDDEN = /\bFORBIDDEN\b|Resource not accessible by|does not have permission to|must have (?:write|admin) access/i
// GitHub's primary and secondary rate limits (HTTP 403 or 429 with this wording). Every call fails the
// same way until the limit resets, so the merge queue pauses and backs off instead of polling on.
const RATE = /rate limit|HTTP 429|abuse detection/i
const AUTH = /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|no oauth token/i
const NETWORK =
  /error connecting to|could not resolve host|no such host|dial tcp|i\/o timeout|connection refused|network is unreachable|TLS handshake|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i

/** Turns what gh said into one of the failures above. Exported for the tests. */
export function classify(text) {
  const t = String(text ?? '').trim()
  const first = t.split('\n').find((l) => l.trim()) ?? ''
  if (SCOPE.test(t))
    return new GitHubError(
      'scope',
      'The GitHub login gh uses lacks the "project" scope this app needs. Run `gh auth refresh -s project` in a terminal, then refresh.',
    )
  if (RATE.test(t)) return new GitHubError('rate', `GitHub's rate limit was reached (${first.replace(/^gh:\s*/, '')}). Wait a few minutes, then try again.`)
  if (FORBIDDEN.test(t))
    return new GitHubError(
      'forbidden',
      `The GitHub login gh uses may not change this project (GitHub said: ${first.replace(/^gh:\s*/, '')}). Ask the project's owner for write access, then try again.`,
    )
  if (AUTH.test(t)) return new GitHubError('auth', 'gh is not logged in to github.com. Run `gh auth login` in a terminal, then refresh.')
  if (NETWORK.test(t)) return new GitHubError('network', `GitHub could not be reached (${first.replace(/^gh:\s*/, '')}). Check the network, then refresh.`)
  return new GitHubError('github', `GitHub answered with an error: ${first.replace(/^gh:\s*/, '') || 'no message'}`)
}

/**
 * Runs `gh` with arguments (never a shell), and returns its stdout. `input` goes to its stdin (with
 * `--input -`), so a long text never rides on the command line.
 */
export function runGh(args, { timeoutMs = GH_TIMEOUT_MS, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        timeout: timeoutMs,
        ...(cwd ? { cwd } : {}),
        maxBuffer: 64 * 1024 * 1024,
        // No prompts, no colour, no update notice: gh runs with nobody at a terminal.
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        if (error.code === 'ENOENT')
          return reject(
            new GitHubError('gh-missing', 'The GitHub CLI (gh) was not found on this machine. Install it from https://cli.github.com, run `gh auth login`, then refresh.'),
          )
        if (error.killed) return reject(new GitHubError('network', `gh did not answer within ${Math.round(timeoutMs / 1000)} s. Check the network, then refresh.`))
        // A GraphQL error comes back as JSON on stdout with a non-zero exit; keep it for the caller.
        const err = classify(`${stderr}\n${stdout}`)
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      },
    )
    if (input !== undefined) {
      // gh may exit before reading it all (a bad flag); that is its answer, not a crash here
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/** One GraphQL request through `gh api graphql`. Strings go as -f (raw), numbers as -F (typed). */
export async function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(variables)) {
    if (v === undefined || v === null) continue
    args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`)
  }
  let out
  try {
    out = await runGh(args)
  } catch (e) {
    if (!(e instanceof GitHubError) || !e.stdout) throw e
    out = e.stdout
    const errors = parseJson(out)?.errors
    if (!Array.isArray(errors) || errors.length === 0) throw e
  }
  const json = parseJson(out)
  if (!json) throw new GitHubError('github', 'gh answered with something that is not JSON.')
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const text = json.errors.map((x) => `${x.type ?? ''} ${x.message ?? ''}`.trim()).join('\n')
    const err = classify(text)
    if (err.kind === 'github' && json.errors.some((x) => x.type === 'NOT_FOUND')) err.kind = 'not-found'
    throw err
  }
  return json.data
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const BOARD_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id title url
        fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isArchived
            content {
              __typename
              ... on Issue { number title url state repository { nameWithOwner } }
              ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
              ... on DraftIssue { title }
            }
            fieldValues(first: 30) {
              nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } }
            }
          }
        }
      }
    }
  }
}`

/**
 * Reads the whole project: its single-select fields and every item that is not archived.
 * Returns { project, fields: { status, priority, area }, items, fetchedAt }.
 */
export async function readBoard(config) {
  const nodes = []
  let project = null
  let after
  for (let page = 0; page < MAX_PAGES; page++) {
    let data
    try {
      data = await graphql(BOARD_QUERY, { owner: config.owner, number: config.number, after })
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'not-found') throw notFound(config)
      throw e
    }
    const p = data?.repositoryOwner?.projectV2
    if (!p) throw notFound(config)
    project ??= p
    nodes.push(...(p.items?.nodes ?? []))
    if (!p.items?.pageInfo?.hasNextPage) break
    after = p.items.pageInfo.endCursor
  }
  const selects = (project.fields?.nodes ?? []).filter((f) => f && Array.isArray(f.options))
  const field = (name) => {
    const f = selects.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!f) throw new GitHubError('setup', `The project has no single-select field named "${name}" (see project.json).`)
    return { id: f.id, name: f.name, options: f.options.map((o) => ({ id: o.id, name: o.name })) }
  }
  const fields = { status: field(config.fields.status), priority: field(config.fields.priority), area: field(config.fields.area) }
  const items = nodes.filter((n) => n && !n.isArchived).map((n) => toItem(n, fields))
  return {
    project: { id: project.id, title: project.title, url: project.url, owner: config.owner, number: config.number },
    fields,
    items,
    fetchedAt: new Date().toISOString(),
  }
}

const notFound = (config) =>
  new GitHubError('not-found', `GitHub Project #${config.number} of ${config.owner} was not found, or the account gh is logged in as cannot see it. A project can be private to its owner: ask for access, or point project.json at a project your account can see.`)

function toItem(node, fields) {
  const values = {}
  for (const v of node.fieldValues?.nodes ?? []) if (v?.field?.name) values[v.field.name] = v.name
  const c = node.content
  const type = !c ? 'hidden' : c.__typename === 'PullRequest' ? 'pull' : c.__typename === 'Issue' ? 'issue' : 'draft'
  return {
    itemId: node.id,
    type,
    number: c?.number ?? null,
    title: c?.title ?? 'An item this GitHub login cannot see',
    url: c?.url ?? null,
    state: c?.state ?? null,
    draft: c?.isDraft === true,
    repository: c?.repository?.nameWithOwner ?? null,
    status: values[fields.status.name] ?? null,
    priority: values[fields.priority.name] ?? null,
    area: values[fields.area.name] ?? null,
  }
}

/** Sets one single-select field on one project item. */
export async function setOption(projectId, itemId, fieldId, optionId) {
  await graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    { project: projectId, item: itemId, field: fieldId, option: optionId },
  )
}

/** Finds an issue or pull request by repository and number. Returns null when there is none. */
export async function findContent(repo, number) {
  const [owner, name] = repo.split('/')
  let data
  try {
    data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issueOrPullRequest(number: $number) {
            __typename
            ... on Issue { id number title url }
            ... on PullRequest { id number title url }
          }
        }
      }`,
      { owner, name, number },
    )
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'not-found') return null
    throw e
  }
  const c = data?.repository?.issueOrPullRequest
  if (!c) return null
  return { id: c.id, type: c.__typename === 'PullRequest' ? 'pull' : 'issue', number: c.number, title: c.title, url: c.url }
}

/** Adds an issue or pull request to the project; returns the project item id. */
export async function addContent(projectId, contentId) {
  const data = await graphql(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
    { project: projectId, content: contentId },
  )
  return data?.addProjectV2ItemById?.item?.id ?? null
}

/**
 * Reads "8", "#8", "owner/repo#8" or a github.com issue or pull request URL.
 * A bare number means the project's own repository (project.json "repository").
 */
export function parseItemRef(input, defaultRepo) {
  const s = String(input ?? '').trim()
  let m = /^#?(\d+)$/.exec(s)
  if (m) return { repo: defaultRepo, number: Number(m[1]) }
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s)
  if (m) return { repo: m[1], number: Number(m[2]) }
  m = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(s)
  if (m) return { repo: m[1], number: Number(m[2]) }
  throw new GitHubError(
    'input',
    `"${s}" is not an issue or pull request. Give a number such as 8 or #8, owner/repo#8, or a github.com issue or pull request URL.`,
  )
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim()

/** Finds a field's option by name, ignoring case, spaces, dashes and underscores. */
export function resolveOption(field, value) {
  const o = field.options.find((x) => norm(x.name) === norm(value))
  if (!o) throw new GitHubError('input', `${field.name} "${value}" does not exist in this project. Choose one of: ${field.options.map((x) => x.name).join(', ')}.`)
  return o
}

export const sameRepo = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

// --- CI and merging (ci_status, merge_when_green) --------------------------------------------------
// The same gh, through its REST side (`gh api repos/…`) and `gh pr`, always with `-R` or a full
// path, so nothing depends on the folder gh runs in. The merge also runs from the temp folder, so gh
// can never touch the person's checkout.

const REPO = /^[\w.-]+\/[\w.-]+$/
const REF = /^[\w./-]+$/
const httpStatus = (e) => Number(/HTTP (\d{3})/.exec(`${e?.stderr ?? ''}\n${e?.message ?? ''}`)?.[1] ?? 0)
const firstLine = (e) =>
  String(e?.stderr || e?.message || e)
    .split('\n')
    .map((l) => l.replace(/^gh:\s*/, '').trim())
    .find(Boolean) ?? 'no message'
// Failures that say nothing about the thing asked for: gh cannot reach GitHub at all, or may not for now.
export const FATAL = new Set(['network', 'auth', 'gh-missing', 'rate'])

/** Refuses anything but owner/name before it reaches a REST path. */
export function checkRepo(repo) {
  if (!REPO.test(String(repo))) throw new GitHubError('input', `"${repo}" is not a repository; give owner/name.`)
}

/** GET one REST path as JSON. `missing` (HTTP codes) answers null for those instead of throwing. */
export async function restJson(path, { missing = [] } = {}) {
  let out
  try {
    out = await runGh(['api', path])
  } catch (e) {
    if (e instanceof GitHubError && !FATAL.has(e.kind) && missing.includes(httpStatus(e))) return null
    if (e instanceof GitHubError && !FATAL.has(e.kind)) throw new GitHubError('github', `GitHub answered ${path.split('?')[0]} with: ${firstLine(e)}`)
    throw e
  }
  const json = parseJson(out)
  if (json === null) throw new GitHubError('github', `gh answered ${path.split('?')[0]} with something that is not JSON.`)
  return json
}

/** The repository: the logged-in account's permissions on it, and its default branch. */
export async function readRepo(repo) {
  checkRepo(repo)
  const r = await restJson(`repos/${repo}`, { missing: [404] })
  if (!r) throw new GitHubError('not-found', `The repository ${repo} was not found, or the account gh is logged in as cannot see it.`)
  return { permissions: r.permissions ?? {}, defaultBranch: r.default_branch ?? 'main' }
}

const PR_FIELDS = 'number,title,body,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,isCrossRepository,url,mergeCommit'

// The merge queue also reads how GitHub would merge it (DIRTY, BEHIND, BLOCKED, CLEAN, …)
export const QUEUE_PR_FIELDS = `${PR_FIELDS},mergeStateStatus,labels`

/** One pull request, as `gh pr view --json` gives it. */
export async function readPr(repo, number, fields = PR_FIELDS) {
  checkRepo(repo)
  let out
  try {
    out = await runGh(['pr', 'view', String(number), '-R', repo, '--json', fields])
  } catch (e) {
    if (e instanceof GitHubError && !FATAL.has(e.kind)) throw new GitHubError('not-found', `${repo}#${number} is not a pull request this GitHub login can see (${firstLine(e)}).`)
    throw e
  }
  const pr = parseJson(out)
  if (!pr) throw new GitHubError('github', 'gh pr view answered with something that is not JSON.')
  return pr
}

/** The commit a branch, tag or sha names. */
export async function resolveRef(repo, ref) {
  checkRepo(repo)
  if (!REF.test(String(ref))) throw new GitHubError('input', `"${ref}" is not a branch, tag or commit.`)
  const c = await restJson(`repos/${repo}/commits/${ref}`, { missing: [404, 422] })
  if (!c?.sha) throw new GitHubError('not-found', `${repo} has no branch, tag or commit "${ref}".`)
  return c.sha
}

/**
 * The checks that must pass on `base`, and where that came from: branch protection and rulesets
 * first (what GitHub itself enforces), else the jobs of the CI workflows read from `base` itself, so
 * a pull request cannot make its own checks optional by editing them. `names` null: none found.
 *
 * With `head` (a pull request's head commit), the jobs its own workflows add count too: they can
 * only add to the set, never remove from it. Without this a job a pull request introduces was "not
 * required" for that very pull request, and #445 merged with its new job red.
 *
 * With `at` (a commit), the workflows are read at that commit instead of on `base`, and `head` is
 * ignored: the checks that commit's own run reports (a release's tagged commit, after main's
 * workflow changed, #1035). Branch protection still comes first.
 */
export async function readRequired(repo, base, workflows, workflowCheckNames, head, { at } = {}) {
  checkRepo(repo)
  const names = new Set()
  // 404: not protected; 403: this login may not read protection (that needs admin). Rulesets are
  // readable by anyone who can read the repository.
  const protection = await restJson(`repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`, { missing: [403, 404] })
  for (const c of protection?.contexts ?? []) names.add(c)
  for (const c of protection?.checks ?? []) if (c?.context) names.add(c.context)
  const rules = await restJson(`repos/${repo}/rules/branches/${encodeURIComponent(base)}`, { missing: [403, 404] })
  for (const r of Array.isArray(rules) ? rules : [])
    if (r?.type === 'required_status_checks') for (const c of r.parameters?.required_status_checks ?? []) if (c?.context) names.add(c.context)
  if (names.size) return { names: [...names], unresolved: [], source: `branch protection of ${base}` }

  const found = []
  const unresolved = []
  const read = []
  let added = 0
  const own = at ?? base
  for (const ref of at ? [at] : head ? [base, head] : [base]) {
    for (const path of workflows ?? []) {
      let text
      try {
        text = await runGh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`])
      } catch (e) {
        if (e instanceof GitHubError && !FATAL.has(e.kind) && httpStatus(e) === 404) continue
        throw e
      }
      const w = workflowCheckNames(text)
      const file = path.split('/').pop()
      if (ref === own) {
        found.push(...w.names)
        unresolved.push(...w.unresolved.map((j) => `${file} job ${j}`))
        read.push(file)
      } else {
        const before = new Set(found)
        for (const n of w.names) if (!before.has(n)) (found.push(n), added++)
        unresolved.push(...w.unresolved.map((j) => `${file} job ${j} (added by the pull request)`))
      }
    }
  }
  if (!found.length && !unresolved.length) return { names: null, unresolved: [], source: 'no required set found, so every reported check counts' }
  const plus = added ? `, plus ${added} job${added === 1 ? '' : 's'} the pull request adds` : ''
  return { names: [...new Set(found)], unresolved, added, source: `${read.join(', ')} on ${at ? short(at) : base}${plus}` }
}

/** CI runs carry workflow identity; job names alone can collide with release jobs. */
export async function readWorkflowChecks(repo, sha, { workflows, event, branch, pr } = {}) {
  checkRepo(repo)
  const runs = new Map()
  let associated = null
  for (const path of workflows ?? []) {
    const file = path.split('/').pop()
    if (!WORKFLOW.test(file)) throw new GitHubError('input', `"${path}" is not a workflow file name.`)
    const q = new URLSearchParams({ head_sha: sha, per_page: '100', ...(event ? { event } : {}), ...(branch ? { branch } : {}) })
    const pages = parseJson(await runGh(['api', '--paginate', '--slurp', `repos/${repo}/actions/workflows/${file}/runs?${q}`]))
    for (const page of pages ?? []) for (const run of page.workflow_runs ?? []) {
      if (run.head_sha !== sha || (event && run.event !== event) || (branch && run.head_branch !== branch)) continue
      if (pr) {
        if (run.head_branch !== pr.headRefName || run.head_repository?.full_name !== repo) continue
        let prs = run.pull_requests ?? []
        // GitHub removes merged PRs from a run's pull_requests (#624, verified 2026-10-13).
        // Only an unambiguous commit association can recover that identity; never guess by title.
        if (!prs.length) {
          associated ??= await restJson(`repos/${repo}/commits/${sha}/pulls?per_page=100`)
          if (associated?.length !== 1) continue
          prs = associated
        }
        if (!prs.some((p) => p.number === pr.number && p.base?.ref === pr.baseRefName && p.head?.sha === sha && p.head?.ref === pr.headRefName)) continue
      }
      const old = runs.get(run.id)
      if (!old || (run.run_attempt ?? 1) >= (old.run_attempt ?? 1)) runs.set(run.id, run)
    }
  }
  const suites = new Set([...runs.values()].map((r) => r.check_suite_id).filter(Boolean))
  const reported = (await readChecks(repo, sha)).filter((c) => c.kind === 'run' && c.appSlug === 'github-actions' && suites.has(c.suiteId))
  return { reported, runs: [...runs.values()] }
}

/** Every check reported on a commit: check runs (GitHub Actions jobs among them) and commit statuses. */
export async function readChecks(repo, sha) {
  checkRepo(repo)
  const out = []
  for (let page = 1; page <= 10; page++) {
    const r = await restJson(`repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
    const runs = r?.check_runs ?? []
    for (const c of runs) {
      const job = /\/job\/(\d+)/.exec(c.html_url ?? '')?.[1] ?? (c.app?.slug === 'github-actions' ? String(c.id) : null)
      out.push({ kind: 'run', appSlug: c.app?.slug, suiteId: c.check_suite?.id, name: c.name, status: c.status, conclusion: c.conclusion, id: c.id, jobId: job, url: c.html_url ?? null, at: c.started_at ?? c.completed_at ?? null })
    }
    if (runs.length < 100) break
  }
  const s = await restJson(`repos/${repo}/commits/${sha}/status`)
  for (const st of s?.statuses ?? []) out.push({ kind: 'status', name: st.context, state: st.state, id: st.id, jobId: null, url: st.target_url ?? null, at: st.updated_at ?? null })
  return out
}

/** A GitHub Actions job's log as text (colour codes included; ci.mjs strips them). */
export async function readJobLog(repo, jobId) {
  checkRepo(repo)
  const path = `repos/${repo}/actions/jobs/${jobId}/logs`
  try {
    // gh 2.8x and later refuse to print a response holding terminal escape sequences (a coloured
    // test log does) without this flag; an older gh does not know the flag and prints it anyway.
    return await runGh(['api', '--allow-escape-sequences', path], { timeoutMs: 60_000 }).catch((e) => {
      if (/unknown flag/.test(e?.stderr ?? '')) return runGh(['api', path], { timeoutMs: 60_000 })
      throw e
    })
  } catch (e) {
    if (e instanceof GitHubError && !FATAL.has(e.kind)) throw new GitHubError('github', `the log of job ${jobId} could not be read: ${firstLine(e)}`)
    throw e
  }
}

/** An issue's body and comments as one text, and its state. */
export async function readIssueText(repo, number) {
  checkRepo(repo)
  const out = await runGh(['issue', 'view', String(number), '-R', repo, '--json', 'body,comments,state'])
  const j = parseJson(out)
  if (!j) throw new GitHubError('github', 'gh issue view answered with something that is not JSON.')
  return { text: [j.body ?? '', ...(j.comments ?? []).map((c) => c?.body ?? '')].join('\n\n'), state: j.state ?? null }
}

/**
 * Squash-merges a pull request, only while its head is still `sha` (a push after the checks were
 * read makes GitHub refuse). Never `--auto`: auto-merge would merge on GitHub's own reading of the
 * checks, which is the decision this app exists to make. No author flag, so the commit is the PR
 * author's (GitHub's squash default). Returns null, or the reason GitHub gave.
 */
export async function mergePr(repo, number, sha, subject, body) {
  checkRepo(repo)
  try {
    await runGh(['pr', 'merge', String(number), '-R', repo, '--squash', '--match-head-commit', sha, '--subject', subject, '--body', body], {
      cwd: tmpdir(),
      timeoutMs: 120_000,
    })
    return null
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return firstLine(e)
  }
}

/** Marks a draft pull request ready for review (mark_ready). */
export async function markReady(repo, number) {
  checkRepo(repo)
  try {
    await runGh(['pr', 'ready', String(number), '-R', repo], { cwd: tmpdir() })
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    throw new GitHubError('github', `GitHub refused to mark ${repo}#${number} ready for review: ${firstLine(e)}`)
  }
}

/**
 * Turns a pull request into a draft (open_pr, for the one a new pull request is stacked on): a stack's
 * lower pull requests are drafts, and build.yml runs no CI for a draft (#1066).
 */
export async function markDraft(repo, number) {
  checkRepo(repo)
  try {
    await runGh(['pr', 'ready', String(number), '--undo', '-R', repo], { cwd: tmpdir() })
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    throw new GitHubError('github', `GitHub refused to turn ${repo}#${number} into a draft: ${firstLine(e)}`)
  }
}

/** Deletes a branch of the repository on GitHub. Returns null, or the reason GitHub gave. */
export async function deleteBranch(repo, branch) {
  checkRepo(repo)
  if (!REF.test(String(branch))) return `"${branch}" is not a branch name`
  try {
    await runGh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`])
    return null
  } catch (e) {
    return firstLine(e)
  }
}

// --- The merge queue (queue-driver.mjs) ---------------------------------------------------------------

/** Starts a completed run again: all of its jobs, or only the failed ones. GitHub answers nothing. */
export async function rerunRun(repo, runId, { failedOnly = false } = {}) {
  checkRepo(repo)
  try {
    await runGh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${Number(runId)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`])
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    throw new GitHubError('github', `GitHub refused to rerun run ${runId}: ${firstLine(e)}`)
  }
}

/** Closes a pull request with a comment (never its branch: that is deleted on its own, through the API). */
export async function closePr(repo, number, comment) {
  checkRepo(repo)
  try {
    await runGh(['pr', 'close', String(number), '-R', repo, '--comment', comment], { cwd: tmpdir() })
    return null
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return firstLine(e)
  }
}

/** Whether `head` contains `ancestor` (GitHub's compare: ahead or identical). */
export async function containsCommit(repo, ancestor, head) {
  checkRepo(repo)
  const c = await restJson(`repos/${repo}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(head)}`, { missing: [404] })
  return c?.status === 'ahead' || c?.status === 'identical'
}

/** GitHub lists at most this many files of a comparison: a list this long may have been cut. */
export const COMPARE_FILES_MAX = 300

/**
 * The files `head` adds to `base` (GitHub's comparison from their merge base), a renamed file under both names, as
 * ci-changes.mjs reads a change (`--no-renames`). `null` when they are not known: the comparison or its file list is
 * missing, or long enough that GitHub may have cut it.
 */
export async function readCompareFiles(repo, base, head) {
  checkRepo(repo)
  const c = await restJson(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { missing: [404] })
  if (!c || !Array.isArray(c.files) || c.files.length >= COMPARE_FILES_MAX) return null
  return c.files.flatMap((f) => [f.filename, f.previous_filename]).filter((f) => typeof f === 'string' && f)
}

/** The open pull requests whose base is `branch` (deleting it would close them). */
export async function openPrsOnBase(repo, branch) {
  checkRepo(repo)
  if (!REF.test(String(branch))) return []
  const list = parseJson(await runGh(['pr', 'list', '-R', repo, '--base', branch, '--state', 'open', '--limit', '50', '--json', 'number']))
  return Array.isArray(list) ? list.map((p) => p.number) : []
}

// --- Batches of the merge queue (queue-batch.mjs, #962) -------------------------------------------------

/** A commit by branch or sha: its sha and its tree's. */
export async function readCommit(repo, ref) {
  checkRepo(repo)
  if (!REF.test(String(ref))) throw new GitHubError('input', `"${ref}" is not a branch or commit.`)
  const c = await restJson(`repos/${repo}/commits/${encodeURIComponent(ref)}`, { missing: [404, 422] })
  if (!c?.sha || !c.commit?.tree?.sha) throw new GitHubError('not-found', `${repo} has no branch or commit "${ref}".`)
  return { sha: c.sha, tree: c.commit.tree.sha }
}

/** Creates a branch at `sha` on GitHub. Never moves one that exists: GitHub refuses that, and so does this. */
export async function createBranch(repo, branch, sha) {
  checkRepo(repo)
  if (!REF.test(String(branch))) throw new GitHubError('input', `"${branch}" is not a branch name.`)
  await restWrite('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, `the branch ${branch}`)
}

/**
 * Merges `head` (a commit) into the branch `base` on GitHub, as a merge commit there. Answers
 * `{ sha, tree }` of the merge, `{ conflict: true }` (HTTP 409) or `{ nothing: true }` (204: `base`
 * contains it already).
 */
export async function mergeInto(repo, base, head, message) {
  checkRepo(repo)
  let out
  try {
    out = await runGh(['api', '-X', 'POST', `repos/${repo}/merges`, '--input', '-'], { input: JSON.stringify({ base, head, commit_message: message }) })
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    if (httpStatus(e) === 409) return { conflict: true }
    throw new GitHubError('github', `GitHub refused to merge ${short(head)} into ${base}: ${firstLine(e)}`)
  }
  if (!String(out ?? '').trim()) return { nothing: true }
  const c = parseJson(out)
  if (!c?.sha || !c.commit?.tree?.sha) throw new GitHubError('github', `GitHub answered the merge into ${base} with something that is not a commit.`)
  return { sha: c.sha, tree: c.commit.tree.sha }
}

/** Sets a commit status on `sha` (`state` success, failure, error or pending). */
export async function postStatus(repo, sha, { state, context, description, targetUrl }) {
  checkRepo(repo)
  await restWrite('POST', `repos/${repo}/statuses/${sha}`, { state, context, description: String(description).slice(0, 140), ...(targetUrl ? { target_url: targetUrl } : {}) }, `the ${context} status`)
}

// --- Reading an item and answering it (the reader in the view) --------------------------------------
// One GraphQL query for the item and a page of its comments, newest page first: a thread longer than
// the limit keeps its latest comments, which are the ones a decision turns on.

const THREAD_PAGE = 100
export const THREAD_MAX_COMMENTS = 1000

const COMMENTS = `comments(last: ${THREAD_PAGE}, before: $before) {
  totalCount
  pageInfo { hasPreviousPage startCursor }
  nodes { id url body createdAt author { login } }
}`
const THREAD_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { number title url state stateReason body createdAt author { login } labels(first: 50) { nodes { name } } ${COMMENTS} }
      ... on PullRequest { number title url state isDraft merged body createdAt author { login } labels(first: 50) { nodes { name } } ${COMMENTS} }
    }
  }
}`

/**
 * An issue or pull request with its comments, oldest first, at most `max` of them (the latest).
 * Returns null when there is no such item this login can see.
 */
export async function readThread(repo, number, { max = THREAD_MAX_COMMENTS } = {}) {
  checkRepo(repo)
  const [owner, name] = repo.split('/')
  let item = null
  let before
  const pages = []
  let total = 0
  for (let fetched = 0; fetched < max; ) {
    let data
    try {
      data = await graphql(THREAD_QUERY, { owner, name, number, before })
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'not-found') return null
      throw e
    }
    const c = data?.repository?.issueOrPullRequest
    if (!c) return null
    item ??= c
    const page = c.comments?.nodes ?? []
    total = c.comments?.totalCount ?? total
    pages.unshift(page)
    fetched += page.length
    if (!c.comments?.pageInfo?.hasPreviousPage || page.length === 0) break
    before = c.comments.pageInfo.startCursor
  }
  const comments = pages
    .flat()
    .slice(-max)
    .map((n) => ({ id: n.id, url: n.url ?? null, author: n.author?.login ?? 'ghost', createdAt: n.createdAt ?? null, body: n.body ?? '' }))
  return {
    type: item.__typename === 'PullRequest' ? 'pull' : 'issue',
    repository: repo,
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.merged ? 'MERGED' : item.state,
    stateReason: item.stateReason ?? null,
    draft: item.isDraft === true,
    author: item.author?.login ?? 'ghost',
    createdAt: item.createdAt ?? null,
    body: item.body ?? '',
    labels: (item.labels?.nodes ?? []).map((l) => l?.name).filter(Boolean),
    comments,
    totalComments: Math.max(total, comments.length),
  }
}

// --- The contribution tools (open_pr, file_issue, rebase_stack) -------------------------------------

/** A file of the repository as text, from `ref` (a branch or commit); null when there is none. */
export async function readRepoFile(repo, path, ref) {
  checkRepo(repo)
  try {
    return await runGh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`])
  } catch (e) {
    if (e instanceof GitHubError && !FATAL.has(e.kind) && httpStatus(e) === 404) return null
    if (e instanceof GitHubError && !FATAL.has(e.kind)) throw new GitHubError('github', `${path} could not be read from ${repo}: ${firstLine(e)}`)
    throw e
  }
}

/** POSTs JSON (on stdin) to a REST path and answers the JSON GitHub sends back. `what` names it in errors. */
async function restWrite(method, path, payload, what) {
  let out
  try {
    out = await runGh(['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(payload) })
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'network') throw new GitHubError('network', `${e.message} ${what} may have gone through anyway: look on GitHub before trying again.`)
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    // GitHub explains a 422 in its JSON (a PR that exists already, a branch that does not)
    const detail = parseJson(e?.stdout ?? '')?.errors?.map((x) => x?.message ?? x?.code).filter(Boolean)
    throw new GitHubError('github', `GitHub refused ${what}: ${firstLine(e)}${detail?.length ? ` (${detail.join('; ')})` : ''}`)
  }
  const json = parseJson(out)
  if (!json) throw new GitHubError('github', `GitHub answered ${what} with something that is not JSON. Look on GitHub before trying again.`)
  return json
}

/** Opens a pull request; answers its number and address. */
export async function createPr(repo, { title, head, base, body, draft }) {
  checkRepo(repo)
  const pr = await restWrite('POST', `repos/${repo}/pulls`, { title, head, base, body, draft: draft === true }, 'the pull request')
  return { number: pr.number, url: pr.html_url ?? null }
}

/** Adds labels to an issue or pull request; GitHub makes a label that does not exist yet. */
export async function addLabels(repo, number, labels) {
  checkRepo(repo)
  await restWrite('POST', `repos/${repo}/issues/${number}/labels`, { labels }, `the labels of #${number}`)
}

/** Files an issue; answers its number and address. */
export async function createIssue(repo, { title, body, labels }) {
  checkRepo(repo)
  const issue = await restWrite('POST', `repos/${repo}/issues`, { title, body, ...(labels?.length ? { labels } : {}) }, 'the issue')
  return { number: issue.number, url: issue.html_url ?? null }
}

/** Moves a pull request onto another base branch. */
export async function setPrBase(repo, number, base) {
  checkRepo(repo)
  await restWrite('PATCH', `repos/${repo}/pulls/${number}`, { base }, `the new base of #${number}`)
}

/** The pull requests whose head branch is `branch`, newest first, open or not. */
export async function prsWithHead(repo, branch) {
  checkRepo(repo)
  if (!REF.test(String(branch))) return []
  const out = await runGh(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--limit', '10', '--json', 'number,state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit,isCrossRepository,labels'])
  const list = parseJson(out)
  return Array.isArray(list) ? list.sort((a, b) => b.number - a.number) : []
}

/** Posts a comment on an issue or pull request; answers it as GitHub stored it. */
export async function postComment(repo, number, body) {
  checkRepo(repo)
  let out
  try {
    out = await runGh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'], { input: JSON.stringify({ body }) })
  } catch (e) {
    // Cut off while waiting, GitHub may have stored it all the same: say so rather than invite a second copy
    if (e instanceof GitHubError && e.kind === 'network') throw new GitHubError('network', `${e.message} The comment may have been posted anyway: read the item again before posting it a second time.`)
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    if (httpStatus(e) === 404) throw new GitHubError('not-found', `${repo}#${number} is not an issue or pull request this GitHub login can see. Nothing was posted.`)
    throw new GitHubError('github', `GitHub refused the comment on ${repo}#${number}: ${firstLine(e)}. Nothing was posted.`)
  }
  const c = parseJson(out)
  if (!c?.id) throw new GitHubError('github', 'GitHub answered the comment with something that is not one. Look at the item on GitHub before posting again.')
  return { id: c.node_id ?? String(c.id), url: c.html_url ?? null, author: c.user?.login ?? 'ghost', createdAt: c.created_at ?? null, body: c.body ?? body }
}

/** The login gh is using. Kept separate from a comment so an edit never guesses who "me" is. */
export async function viewerLogin() {
  const user = await restJson('user')
  if (!user?.login) throw new GitHubError('github', 'GitHub did not say which account gh is using.')
  return user.login
}

/** Replaces a comment body. The caller first proves that the comment belongs to this account. */
export async function editComment(repo, id, body) {
  checkRepo(repo)
  const c = await restWrite('PATCH', `repos/${repo}/issues/comments/${Number(id)}`, { body }, 'the comment edit')
  if (!c?.id) throw new GitHubError('github', 'GitHub answered the edited comment with something that is not one.')
  return { id: c.node_id ?? String(c.id), url: c.html_url ?? null, author: c.user?.login ?? 'ghost', createdAt: c.updated_at ?? c.created_at ?? null, body: c.body ?? body }
}

/** One issue or pull request comment by its id: the item it is on, its body and author; null when there is none. */
export async function readComment(repo, id) {
  checkRepo(repo)
  const c = await restJson(`repos/${repo}/issues/comments/${Number(id)}`, { missing: [404] })
  if (!c) return null
  return { number: Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? '')?.[1] ?? 0), body: c.body ?? '', author: c.user?.login ?? 'ghost', url: c.html_url ?? null }
}

// --- The release (release.mjs) -----------------------------------------------------------------------
// The release workflow's runs, their jobs and the environment approvals they wait on. `workflow` is the
// file name (`release.yml`), which GitHub's REST paths take in place of the workflow's id.

const WORKFLOW = /^[\w.-]+\.ya?ml$/

const runOf = (w) => ({
  id: w.id,
  status: w.status,
  conclusion: w.conclusion ?? null,
  event: w.event,
  headBranch: w.head_branch ?? null,
  headSha: w.head_sha,
  url: w.html_url ?? null,
  createdAt: w.created_at ?? null,
  attempt: w.run_attempt ?? 1,
  // The run's name (`run-name`): release.yml names a rehearsal after the version it builds (#1501)
  title: w.display_title ?? null,
})

/** The workflow's latest runs, newest first, for one event, commit and branch when given. */
export async function workflowRuns(repo, workflow, { event, headSha, branch } = {}) {
  checkRepo(repo)
  if (!WORKFLOW.test(String(workflow))) throw new GitHubError('input', `"${workflow}" is not a workflow file name.`)
  if (branch !== undefined && !REF.test(String(branch))) return []
  const q = new URLSearchParams({ per_page: '30', ...(event ? { event } : {}), ...(headSha ? { head_sha: headSha } : {}), ...(branch ? { branch } : {}) })
  const r = await restJson(`repos/${repo}/actions/workflows/${workflow}/runs?${q}`, { missing: [404] })
  return (r?.workflow_runs ?? []).map(runOf)
}

/** A run's jobs: name, status (`waiting` while an environment holds it) and conclusion. */
export async function runJobs(repo, runId) {
  checkRepo(repo)
  const r = await restJson(`repos/${repo}/actions/runs/${Number(runId)}/jobs?per_page=100`)
  return (r?.jobs ?? []).map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion ?? null, url: j.html_url ?? null }))
}

/**
 * A run's jobs with their steps, for why it failed (the merge queue's rerun policy, run-failure.mjs):
 * id (the job's check run id too), name, conclusion and each step's name and conclusion. The latest
 * attempt's, as GitHub answers by default.
 */
export async function runJobSteps(repo, runId) {
  checkRepo(repo)
  const r = await restJson(`repos/${repo}/actions/runs/${Number(runId)}/jobs?per_page=100`)
  return (r?.jobs ?? []).map((j) => ({
    id: j.id ?? null,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? null,
    steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion ?? null })),
  }))
}

/** The messages GitHub wrote on a check run (a job): its timeout, a lost runner, an `::error` line. */
export async function checkRunNotes(repo, checkRunId) {
  checkRepo(repo)
  const r = await restJson(`repos/${repo}/check-runs/${Number(checkRunId)}/annotations?per_page=50`, { missing: [404] })
  return (Array.isArray(r) ? r : []).map((a) => String(a?.message ?? '')).filter(Boolean)
}

/**
 * What GitHub and the job's log say about a job that did not pass: its annotations (`checkRunNotes`) and, when the
 * only one is "The operation was canceled." (what a shutdown of the runner leaves, #1507: the job's step says `failure`
 * and no annotation names the runner), the log's shutdown line. Best effort: a log that cannot be read leaves the
 * annotations as they were; a fatal error (no network, no login, the rate limit) is thrown as everywhere else.
 */
export async function jobNotes(repo, jobId) {
  const notes = await checkRunNotes(repo, jobId)
  if (notes.some((n) => LOST_RUNNER_NOTE.test(n)) || !notes.length || !notes.every((n) => CANCELED_NOTE.test(n.trim()))) return notes
  try {
    const lines = String(await readJobLog(repo, jobId))
      .split(/\r?\n/)
      .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''))
    const at = shutdownAt(lines)
    return at < 0 ? notes : [...notes, String(lines[at]).replace(/^##\[error\]/, '')]
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return notes
  }
}

/** The environments a run waits on for approval, and whether this login may give it. */
export async function pendingDeployments(repo, runId) {
  checkRepo(repo)
  const r = await restJson(`repos/${repo}/actions/runs/${Number(runId)}/pending_deployments`)
  return (Array.isArray(r) ? r : []).map((d) => ({
    environmentId: d.environment?.id,
    environment: d.environment?.name ?? '?',
    canApprove: d.current_user_can_approve === true,
    reviewers: (d.reviewers ?? []).map((x) => x?.reviewer?.login ?? x?.reviewer?.name).filter(Boolean),
  }))
}

/** Approves a run's waiting environments, with a comment GitHub keeps beside the approval. */
export async function approveDeployments(repo, runId, environmentIds, comment) {
  checkRepo(repo)
  await restWrite('POST', `repos/${repo}/actions/runs/${Number(runId)}/pending_deployments`, { environment_ids: environmentIds, state: 'approved', comment }, 'the approval')
}

/** Cancels an unneeded workflow run. GitHub keeps any jobs that already completed. */
export async function cancelWorkflowRun(repo, runId) {
  checkRepo(repo)
  try {
    await runGh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${Number(runId)}/cancel`])
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    throw new GitHubError('github', `GitHub refused to cancel run ${runId}: ${firstLine(e)}`)
  }
}

/** Starts a workflow_dispatch run of `workflow` on `ref` with `inputs` (strings). GitHub answers nothing. */
export async function dispatchWorkflow(repo, workflow, ref, inputs) {
  checkRepo(repo)
  if (!WORKFLOW.test(String(workflow))) throw new GitHubError('input', `"${workflow}" is not a workflow file name.`)
  try {
    await runGh(['api', '-X', 'POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`, '--input', '-'], { input: JSON.stringify({ ref, inputs }) })
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    throw new GitHubError('github', `GitHub refused to start ${workflow}: ${firstLine(e)}`)
  }
}

/**
 * How busy the repository's runners are: the jobs of every queued or running workflow run, those on a
 * runner now (`running`) and those waiting for one (`queued`). A job held by an environment approval
 * holds no runner and is not counted.
 */
export async function activeJobs(repo) {
  checkRepo(repo)
  const runs = new Map()
  for (const status of ['in_progress', 'queued']) {
    const r = await restJson(`repos/${repo}/actions/runs?status=${status}&per_page=100`)
    for (const run of r?.workflow_runs ?? []) runs.set(run.id, run)
  }
  const jobs = (await mapLimit([...runs.keys()], 4, (id) => runJobs(repo, id))).flat()
  return {
    runs: runs.size,
    running: jobs.filter((j) => j.status === 'in_progress').length,
    queued: jobs.filter((j) => ['queued', 'pending', 'requested'].includes(j.status)).length,
  }
}
