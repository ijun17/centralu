import { asObj } from '../../json-value.js'
import { pathsOf } from '../../os.js'

/**
 * The person's own `agy` deny rules, which the gate honours on top of Centralu's preset (owner decision on #59, Q1;
 * docs/plans/antigravity-adapter.md §5.2).
 *
 * **Deny only.** A rule here can turn an allow or a card into a deny, never the other way: the person's `allow` and
 * `ask` lists are not read, so their rules can only make a session stricter.
 *
 * Where they come from (measured, `agy` 1.4.8, 2026-10-27): `~/.gemini/antigravity-cli/settings.json`, key
 * `permissions.deny`, a list of strings `kind(target)`. `agy -p /permissions` printed the list back as written, an entry
 * it cannot parse included. The rule kinds, from the binary's own documentation of its grants:
 *
 *   command(<prefix>)          a shell command starting with these words; `command(*)` every command
 *   read_file(<absolute path>) a read of that file or of anything under that folder
 *   write_file(<absolute path>) a write there
 *   mcp(<server>/<tool>)       one MCP tool
 *   read_url(<domain>)         reading a URL on that domain; `execute_url(<domain>)` acting on a page there
 *
 * `agy` applies them itself even under `--dangerously-skip-permissions` (measured: `command(echo deny-me)` denied
 * `echo deny-me` and `echo ok; echo deny-me` and let `echo deny-me-also` run; `write_file(<folder>)` and
 * `read_file(<folder>)` denied a write and a read under the folder, but only when the rule named the path as the call
 * did: a rule under `/tmp` did not catch the same file reached as `/private/tmp`). Honouring them here as well keeps a
 * card from being raised for a call `agy` would refuse after the person allowed it, and covers what `agy`'s own check
 * may not (a rule through a link, the kinds not measured).
 *
 * Where a rule's meaning is not certain, it is read broadly, since a broader deny only asks less of the person's
 * trust: a path rule also matches through links, a command rule matches every part of a compound command, a domain
 * rule matches its subdomains. An entry that is none of the kinds above is ignored, as `agy` ignores it.
 *
 * Not read: the project scope (`~/.gemini/config/projects/`) and the scope shared with the Antigravity app, which
 * `/permissions` also lists. `agy` still applies those itself. A settings file that is missing or cannot be read or
 * parsed gives no rules: the preset alone decides.
 *
 * It touches no file itself (docs/plans/os-layer.md): the caller hands it the read, the OS layer's `files.readFile`.
 */

const path = pathsOf()

export type DenyRule =
  | { kind: 'command'; prefix: string[] | '*'; text: string }
  | { kind: 'read_file' | 'write_file'; path: string; text: string }
  | { kind: 'mcp'; server: string; tool: string; text: string }
  | { kind: 'read_url' | 'execute_url'; domain: string; text: string }

/** What one call is, as far as the rules ask: what it runs, the paths it reads or writes, the MCP tool, the URLs */
export type RuleTarget = {
  command?: string
  reads?: readonly string[]
  writes?: readonly string[]
  mcp?: { server: string; tool: string }
  readUrls?: readonly string[]
  executeUrls?: readonly string[]
}

/** The person's `agy` settings file under their home folder (measured location, `agy` 1.4.8 on macOS) */
export function agySettingsPath(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
}

/**
 * Where `agy` writes one descriptor per MCP tool (`<server>/<tool>.json`), which the model reads before it calls the tool
 * (measured, §1.3)
 */
export function agyMcpDescriptors(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'mcp')
}

/**
 * The deny rules in the settings file at `path`, read with `read` (`(p) => os.files.readFile(p, 'utf8')`); none when it is
 * missing or cannot be read or parsed (the preset alone decides)
 */
export async function readDenyRules(read: (path: string) => Promise<string>, path: string): Promise<DenyRule[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await read(path))
  } catch {
    return []
  }
  const deny = asObj(asObj(raw).permissions).deny
  if (!Array.isArray(deny)) return []
  return deny.flatMap((entry) => {
    const rule = typeof entry === 'string' ? parseRule(entry) : null
    return rule ? [rule] : []
  })
}

const RULE = /^\s*([a-z_]+)\((.*)\)\s*$/s

/** One `kind(target)` entry, or null for one that is none of the known kinds */
export function parseRule(text: string): DenyRule | null {
  const m = RULE.exec(text)
  if (!m) return null
  const kind = m[1] ?? ''
  const target = (m[2] ?? '').trim()
  if (!target) return null
  switch (kind) {
    case 'command':
      return { kind, prefix: target === '*' ? '*' : words(target), text }
    case 'read_file':
    case 'write_file':
      return target === '*' || path.isAbsolute(target) ? { kind, path: target, text } : null
    case 'mcp': {
      if (target === '*') return { kind, server: '*', tool: '*', text }
      const slash = target.indexOf('/')
      if (slash <= 0 || slash === target.length - 1) return null
      return { kind, server: target.slice(0, slash), tool: target.slice(slash + 1), text }
    }
    case 'read_url':
    case 'execute_url':
      return { kind, domain: target.toLowerCase(), text }
    default:
      return null
  }
}

/** The first rule that denies this call, or null */
export function deniedBy(rules: readonly DenyRule[], target: RuleTarget, realPaths: ReadonlyMap<string, string> = new Map()): DenyRule | null {
  for (const rule of rules) if (matches(rule, target, realPaths)) return rule
  return null
}

function matches(rule: DenyRule, t: RuleTarget, realPaths: ReadonlyMap<string, string>): boolean {
  switch (rule.kind) {
    case 'command':
      return t.command !== undefined && commandParts(t.command).some((part) => rule.prefix === '*' || startsWithWords(part, rule.prefix))
    case 'read_file':
    case 'write_file': {
      const paths = rule.kind === 'read_file' ? t.reads : t.writes
      if (!paths?.length) return false
      if (rule.path === '*') return true
      const ruleReal = realPaths.get(rule.path)
      return paths.some((p) => [p, realPaths.get(p)].some((q) => q !== undefined && [rule.path, ruleReal].some((r) => r !== undefined && under(q, r))))
    }
    case 'mcp':
      return t.mcp !== undefined && (rule.server === '*' || rule.server === t.mcp.server) && (rule.tool === '*' || rule.tool === t.mcp.tool)
    case 'read_url':
    case 'execute_url': {
      const urls = rule.kind === 'read_url' ? t.readUrls : t.executeUrls
      return !!urls?.some((u) => onDomain(u, rule.domain))
    }
  }
}

/** The paths a rule set compares through links: every absolute path named by a path rule */
export function rulePaths(rules: readonly DenyRule[]): string[] {
  return rules.flatMap((r) => ((r.kind === 'read_file' || r.kind === 'write_file') && r.path !== '*' ? [r.path] : []))
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean)

/**
 * The simple commands in a command line: split at `;`, `&`, `|`, newlines and the start of a `$(`, a backtick or a
 * parenthesis, without reading quotes. Not reading quotes splits more than a shell does, which can only find more parts
 * that start with a denied prefix. Leading `NAME=value` assignments are skipped.
 */
function commandParts(line: string): string[][] {
  return line
    .split(/[;&|\n\r(`]|\$\(/)
    .map((part) => {
      const w = words(part.replace(/[)]/g, ' '))
      while (w.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? '')) w.shift()
      return w
    })
    .filter((w) => w.length > 0)
}

function startsWithWords(part: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || part.length < prefix.length) return false
  return prefix.every((word, i) => {
    const got = part[i] ?? ''
    // The first word is the program: `/bin/rm` is `rm`
    return i === 0 ? got === word || got.endsWith(`/${word}`) : got === word
  })
}

function under(p: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p))
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}

function onDomain(url: string, domain: string): boolean {
  if (domain === '*') return true
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    host = url.toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/:?#]/)[0] ?? ''
  }
  return host === domain || host.endsWith(`.${domain}`)
}
