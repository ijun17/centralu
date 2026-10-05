// Everything this app knows about GitHub. It talks to GitHub only through the person's own `gh`
// CLI (`gh api graphql` for the board, `gh api repos/…` and `gh pr` for CI and merging), so the app
// holds no token: gh keeps its login in the system keychain, and
// nothing here reads, stores or prints it. GitHub is the only copy of the board; server.mjs keeps a
// short in-memory cache and nothing on disk.
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'

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
  if (FORBIDDEN.test(t))
    return new GitHubError(
      'forbidden',
      `The GitHub login gh uses may not change this project (GitHub said: ${first.replace(/^gh:\s*/, '')}). Ask the project's owner for write access, then try again.`,
    )
  if (AUTH.test(t)) return new GitHubError('auth', 'gh is not logged in to github.com. Run `gh auth login` in a terminal, then refresh.')
  if (NETWORK.test(t)) return new GitHubError('network', `GitHub could not be reached (${first.replace(/^gh:\s*/, '')}). Check the network, then refresh.`)
  return new GitHubError('github', `GitHub answered with an error: ${first.replace(/^gh:\s*/, '') || 'no message'}`)
}

/** Runs `gh` with arguments (never a shell), and returns its stdout. */
export function runGh(args, { timeoutMs = GH_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
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
// Failures that say nothing about the thing asked for: gh cannot reach GitHub at all.
const FATAL = new Set(['network', 'auth', 'gh-missing'])

function checkRepo(repo) {
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

/** One pull request, as `gh pr view --json` gives it. */
export async function readPr(repo, number) {
  checkRepo(repo)
  let out
  try {
    out = await runGh(['pr', 'view', String(number), '-R', repo, '--json', PR_FIELDS])
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
 */
export async function readRequired(repo, base, workflows, workflowCheckNames) {
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
  for (const path of workflows ?? []) {
    let text
    try {
      text = await runGh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`])
    } catch (e) {
      if (e instanceof GitHubError && !FATAL.has(e.kind) && httpStatus(e) === 404) continue
      throw e
    }
    const w = workflowCheckNames(text)
    const file = path.split('/').pop()
    found.push(...w.names)
    unresolved.push(...w.unresolved.map((j) => `${file} job ${j}`))
    read.push(file)
  }
  if (!found.length && !unresolved.length) return { names: null, unresolved: [], source: 'no required set found, so every reported check counts' }
  return { names: [...new Set(found)], unresolved, source: `${read.join(', ')} on ${base}` }
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
      out.push({ kind: 'run', name: c.name, status: c.status, conclusion: c.conclusion, id: c.id, jobId: job, url: c.html_url ?? null, at: c.started_at ?? c.completed_at ?? null })
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
