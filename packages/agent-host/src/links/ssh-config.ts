import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, parse, sep } from 'node:path'
import { runSsh, SshRunFailure } from './ssh-run.js'
import { lastLine } from './tunnel.js'

/**
 * The hosts of the person's ssh config, for the Add machine dialog (#514): the dialog lists them,
 * as VS Code's Remote-SSH does, so linking a machine needs no typing.
 *
 * Read here, by the host, and never by the window. Only the config's text is read, the way OpenSSH
 * reads it (readconf.c): `Include` takes globs and paths relative to `~/.ssh` and is read where it
 * stands, nested at most 16 deep; `Host` takes several patterns, quoted or not; `Match` opens a block
 * whose conditions only ssh can evaluate. What an alias resolves to is asked of `ssh -G`, which prints
 * the resolved configuration and exits before it loads any key, so no `IdentityFile` is ever opened,
 * by this file or by ssh.
 */

/** One concrete alias, where it is declared */
export type ConfigHost = { alias: string; file: string; line: number }

export type ConfigRead = {
  hosts: ConfigHost[]
  /** What was left out, in words for the person */
  notes: string[]
}

/** OpenSSH's READCONF_MAX_DEPTH: an `Include` nested deeper is refused there too */
const MAX_DEPTH = 16

/**
 * One config line as OpenSSH 8.7+ splits it (`argv_split` with comments): the keyword ends at
 * whitespace or one `=`, arguments are separated by whitespace, double or single quotes group, a
 * backslash takes the next quote, backslash or space literally, and a `#` that starts an argument
 * ends the line. Null for a blank line or a comment.
 */
export function splitConfigLine(raw: string): { keyword: string; args: string[] } | null {
  const m = /^\s*([^\s=#]+)\s*(?:=\s*)?([\s\S]*)$/.exec(raw)
  if (!m) return null
  const args: string[] = []
  const rest = m[2]!
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!
    if (quote) {
      if (c === '\\' && (rest[i + 1] === quote || rest[i + 1] === '\\')) cur += rest[++i]
      else if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      if (inToken) args.push(cur)
      cur = ''
      inToken = false
      continue
    }
    if (c === '#' && !inToken) break
    inToken = true
    if (c === '"' || c === "'") quote = c
    else if (c === '\\' && /["'\\ ]/.test(rest[i + 1] ?? '')) cur += rest[++i]
    else cur += c
  }
  if (inToken) args.push(cur)
  return { keyword: m[1]!.toLowerCase(), args }
}

/** An alias the person can link: not a pattern (`*`, `?`), not negated, not empty */
export function isConcreteAlias(pattern: string): boolean {
  return pattern.length > 0 && !/[*?]/.test(pattern) && !pattern.startsWith('!') && !pattern.startsWith('-') && !/\s/.test(pattern)
}

const MAGIC = /[*?[]/

/** A glob(3) segment as a regular expression: `*`, `?`, `[...]` and `[!...]`; a leading dot is matched only by a dot */
function segmentRe(seg: string): RegExp {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2)
      if (end === -1) re += '\\['
      else {
        let body = seg.slice(i + 1, end)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        re += `[${body.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * What a path with glob characters names, sorted as glob(3) sorts: only regular files, a missing
 * folder matching nothing. A path with no glob character is answered as itself
 */
export function expandGlob(path: string): string[] {
  if (!MAGIC.test(path)) return [path]
  // The OS's own separator: on a Windows hub `normalize` turns the config's `/` into `\`
  const norm = normalize(path)
  const root = parse(norm).root
  let found = [root || '.']
  for (const seg of norm.slice(root.length).split(sep)) {
    if (seg === '') continue
    const next: string[] = []
    for (const base of found) {
      if (!MAGIC.test(seg)) {
        next.push(join(base, seg))
        continue
      }
      let names: string[]
      try {
        names = readdirSync(base)
      } catch {
        continue
      }
      const re = segmentRe(seg)
      for (const name of names.sort()) {
        if (name.startsWith('.') && !seg.startsWith('.')) continue
        if (re.test(name)) next.push(join(base, name))
      }
    }
    found = next
  }
  return found.filter((f) => {
    try {
      return statSync(f).isFile()
    } catch {
      return false
    }
  })
}

/** `~` for the home folder, for what the person reads */
export function tildePath(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/**
 * The concrete aliases of a user ssh config and what it includes, in the order ssh reads them, each
 * once (the first declaration wins, as ssh's first obtained value does)
 */
export function readSshConfig(opts: { file: string; home: string }): ConfigRead {
  const hosts: ConfigHost[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  const matches: string[] = []
  const where = (file: string, line: number) => `${tildePath(file, opts.home)}:${line}`
  const reading: string[] = []
  const read = (file: string, depth: number) => {
    // A file that includes itself, directly or not: ssh would stop at the depth limit; reading it again adds nothing
    if (reading.includes(file)) {
      notes.push(`${tildePath(file, opts.home)} includes itself; it was read once`)
      return
    }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      // The top file missing is the ordinary case (no config yet); an Include that names nothing is skipped by ssh too
      if (depth > 0 && (err as NodeJS.ErrnoException).code !== 'ENOENT') notes.push(`${tildePath(file, opts.home)} could not be read`)
      return
    }
    reading.push(file)
    const lines = text.split('\n')
    for (let n = 0; n < lines.length; n++) {
      const split = splitConfigLine(lines[n]!)
      if (!split) continue
      if (split.keyword === 'host') {
        for (const alias of split.args) {
          if (!isConcreteAlias(alias) || seen.has(alias)) continue
          seen.add(alias)
          hosts.push({ alias, file: tildePath(file, opts.home), line: n + 1 })
        }
      } else if (split.keyword === 'match') {
        matches.push(where(file, n + 1))
      } else if (split.keyword === 'include') {
        if (depth + 1 > MAX_DEPTH) {
          notes.push(`An Include nested more than ${MAX_DEPTH} deep (${where(file, n + 1)}) was not read, as ssh refuses it`)
          continue
        }
        for (const arg of split.args) {
          let path = arg
          // Windows' OpenSSH reads `~\` as `~/` (#849; measured with 9.5p2: `Include ~\x` is "include ~/x")
          if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) path = join(opts.home, path.slice(2))
          else if (path.startsWith('~')) {
            notes.push(`An Include of another user's folder (${where(file, n + 1)}) was not read`)
            continue
          } else if (!isAbsolute(path)) path = join(opts.home, '.ssh', path)
          for (const f of expandGlob(path)) read(f, depth + 1)
        }
      }
    }
    reading.pop()
  }
  read(opts.file, 0)
  if (matches.length > 0) {
    // Its conditions are ssh's to evaluate (exec, user, host); the hosts' details from `ssh -G` already include what it sets
    notes.push(`${matches.length === 1 ? 'A Match block' : `${matches.length} Match blocks`} (${matches.join(', ')}) ${matches.length === 1 ? 'is' : 'are'} not listed; ssh still applies ${matches.length === 1 ? 'it' : 'them'}`)
  }
  return { hosts, notes }
}

/** What `ssh -G <alias>` resolves, the three fields the dialog shows */
export type ResolvedHost = { hostName: string | null; user: string | null; port: number | null; error: string | null }

/** `ssh -G`'s lines, `keyword value`, the first of each keyword */
export function parseSshG(stdout: string): Omit<ResolvedHost, 'error'> {
  const first = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(.*?)\s*$/.exec(line)
    if (m && !first.has(m[1]!.toLowerCase())) first.set(m[1]!.toLowerCase(), m[2]!)
  }
  const port = Number(first.get('port'))
  return { hostName: first.get('hostname') || null, user: first.get('user') || null, port: Number.isInteger(port) && port > 0 ? port : null }
}

export type SshGOptions = {
  ssh?: string
  /** `ssh -F`, for tests: the config ssh reads instead of the person's */
  configFile?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** `ssh -G -- <alias>`: no connection, no key loaded (ssh exits after printing its configuration) */
export function resolveAlias(alias: string, opts: SshGOptions = {}): Promise<ResolvedHost> {
  const args = [...(opts.configFile ? ['-F', opts.configFile] : []), '-G', '--', alias]
  const none = (error: string): ResolvedHost => ({ hostName: null, user: null, port: null, error })
  return runSsh({ ssh: opts.ssh, args, env: opts.env, timeoutMs: opts.timeoutMs ?? 5_000, label: alias }).then(
    ({ code, stdout, stderr }) => (code === 0 ? { ...parseSshG(stdout), error: null } : none(lastLine(stderr) || `ssh -G exited ${code}`)),
    (e: unknown) => {
      const kind = e instanceof SshRunFailure ? e.kind : 'spawn'
      return none(kind === 'timeout' ? 'ssh -G did not answer' : kind === 'spawn' ? `Could not run ssh: ${(e as Error).message}` : (e as Error).message)
    },
  )
}

/** The most aliases listed, each one `ssh -G`; a config past it is said in a note */
export const MAX_HOSTS = 100
/** How many `ssh -G` run at once */
const RESOLVE_AT_ONCE = 8

export type SshHostsOptions = SshGOptions & {
  /** The home folder (`~`), for `~/.ssh/config` and relative includes */
  home?: string
  /** For tests: what resolves an alias in place of `ssh -G` */
  resolve?: (alias: string) => Promise<ResolvedHost>
}

export type ListedHost = ConfigHost & Omit<ResolvedHost, 'error'>

/**
 * The person's `~/.ssh/config` (or `configFile`), its concrete aliases resolved, at most `MAX_HOSTS`.
 * An alias ssh cannot resolve is listed without its details; when ssh cannot resolve any, that is a note
 */
export async function listSshHosts(opts: SshHostsOptions = {}): Promise<{ configFile: string; hosts: ListedHost[]; notes: string[] }> {
  const home = opts.home ?? homedir()
  const file = opts.configFile ?? join(home, '.ssh', 'config')
  const read = readSshConfig({ file, home })
  const notes = [...read.notes]
  const listed = read.hosts.slice(0, MAX_HOSTS)
  if (read.hosts.length > MAX_HOSTS) notes.push(`Only the first ${MAX_HOSTS} of ${read.hosts.length} hosts are listed; type any other below`)
  const resolve = opts.resolve ?? ((alias: string) => resolveAlias(alias, opts))
  const resolved: ResolvedHost[] = new Array(listed.length)
  let next = 0
  const worker = async () => {
    while (next < listed.length) {
      const i = next++
      resolved[i] = await resolve(listed[i]!.alias)
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOLVE_AT_ONCE, listed.length) }, worker))
  const failed = resolved.filter((r) => r.error)
  if (failed.length > 0 && failed.length === resolved.length) notes.push(`ssh -G could not resolve the hosts: ${failed[0]!.error}`)
  return {
    configFile: tildePath(file, home),
    hosts: listed.map((h, i) => ({ ...h, hostName: resolved[i]!.hostName, user: resolved[i]!.user, port: resolved[i]!.port })),
    notes,
  }
}
