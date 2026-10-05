// Everything this app knows about GitHub. It talks to GitHub only through the person's own `gh`
// CLI (`gh api graphql`), so the app holds no token: gh keeps its login in the system keychain, and
// nothing here reads, stores or prints it. GitHub is the only copy of the board; server.mjs keeps a
// short in-memory cache and nothing on disk.
import { execFile } from 'node:child_process'

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
export function runGh(args, { timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        timeout: timeoutMs,
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
