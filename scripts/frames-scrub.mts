#!/usr/bin/env -S npx tsx
/**
 * Turns a raw recording of a tool's frames (ACP or any JSON-lines protocol) into a fixture (docs/plans/acp-adapter.md §10.1, #1498).
 *
 *   pnpm exec tsx scripts/frames-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>
 *   pnpm exec tsx scripts/frames-scrub.mts --rescrub <fixture.jsonl>...   # a committed fixture again, in place
 *
 * The raw file is the host's (`CC_RECORD_FRAMES`, lines `{t, dir, line}`) or a probe's (`{t, dir, msg}`). The fixture is one
 * header line, then `{t, dir: 'in' | 'out', msg}` per frame and `{t, dir: 'exit', code, signal}` when the process ended.
 * Scrubbed:
 *
 * - the working folder, the home folder and the temp folder become `<cwd>`, `<home>` and `<tmp>`, in each form a path
 *   takes (with or without its drive, `\` or `/`); so does any other person's home or temp folder on Windows, macOS and
 *   Linux (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, `/private/var/folders/…/T`), and the user name alone;
 * - text the agent streams in chunks (ACP and Claude chunks, Codex's item deltas) is scrubbed joined, then split again where it was
 *   (#1562 review: a path split across two chunks kept the user name); so is the name of a folder a recorder made, whose six random
 *   characters go and whose name stays (`frames-record-other-BGKZTo` reads `frames-record-other`, #2065);
 * - session, tool call and message ids become stable placeholders;
 * - anything shaped like a credential or an email address is removed, and so is the value of an environment entry named
 *   like one (the bridge's `CC_BRIDGE_TOKEN` in `session/new`);
 * - the command list (the person's own skills among them) keeps only how many there were, as `command-<n>`;
 * - Claude Code's stream-json: ids keep their shape (a UUID stays one, with Centralu's own input mark) and are numbered;
 *   what the CLI says of the person's setup (account, plugins, connectors, commands, skills, agents) keeps only what ships
 *   with the CLI; a path under a placeholder folder reads with `/`; the folder's name as Claude Code files it
 *   (`C--Users-name-…`) is a placeholder too; the deltas of a streamed answer or tool input are scrubbed joined, as chunks are;
 * - Codex's app-server: its ids are UUIDs (kept in shape and numbered, as Claude's) and the provider's `msg_`, `rs_`, `call_` ids;
 *   the host's name (`remoteControl/status/changed`), the account's plan and how much of its allowance was used are replaced;
 * - Centralu's bridge in a Codex thread's config (`frames-record-host.mts`): the node program, the bridge file, the host's port and the
 *   session's credential are placeholders;
 * - stderr is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
// @ts-expect-error — plain .mjs, as the other scripts import theirs
import { isMain } from './is-main.mjs'

type Frame = { t: number; dir: string; msg?: unknown; line?: string; raw?: string }

const UUID_ANYWHERE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** The last group of the ids Centralu mints for its own inputs (`centraluInputId`): kept, since the adapter reads it back */
const CENTRALU_INPUT_MARK = 'ce47a1ce47a1'
/** Claude Code's own agents; any other is the person's */
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude', 'claude-code-guide'])
/** The deltas of a streamed answer, and the field of each that holds the piece */
const DELTA_FIELDS: Record<string, string> = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' }

const SECRET = /\b(?:figd_[\w-]+|sk-[\w-]{16,}|ghp_\w{20,}|gho_\w{20,}|xox[abp]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b|\bccb\d+:[\w-]+:[\w-]{16,}/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
/** Another person's home or temp folder: what the machine's own folders did not already cover */
const FOREIGN: readonly [RegExp, string][] = [
  [/(?:\/private)?\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T(?=[/\\\s"'`]|$)/g, '<tmp>'],
  // The folders above the temp folder, as a tool lists the ancestors of the one it works in (Codex's `projects` trust map)
  [/(?:\/private)?\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+(?=[\s"'`]|$)/g, '<tmp-parent>'],
  [/(?:\/private)?\/var\/folders\/[^/\s"'`]+(?=[\s"'`]|$)/g, '<tmp-parent>'],
  [/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/g, '<home>'],
  [/(?<![\w<])(?:\\|\/)?Users[\\/]+(?!Shared\b)[^\\/\s"'`<>]+(?=[\\/])/g, '<home>'],
  [/\/home\/[^/\s"'`<>]+/g, '<home>'],
]

/**
 * A folder a recorder makes with a random suffix (`mkdtemp`, six characters): the run's data folder, and the folders a scenario works
 * in, which a tool also names without their path (a project's name in an answer). The name keeps what the folder is for. Found in the
 * text joined, like a path, since a streamed answer may cut the suffix across pieces
 */
const RECORDER_FOLDER = /\bframes-(?:data|raw|record-[a-z-]+?)-[A-Za-z0-9]{6}\b/g

/** The kinds of update whose text an agent streams in pieces */
const CHUNKED = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])

export type ScrubPlaces = {
  cwd: string
  home?: string
  tmp?: string
  user?: string
  /** What a UUID in a text becomes, so that one cut across two streamed chunks (a path with a session id in it) is replaced whole */
  uuid?: (id: string) => string
}
export type ScrubOptions = Omit<ScrubPlaces, 'cwd' | 'home'> & { /** A text longer than this is cut to its start and the number of characters left out: a bulky output that only fills a context */ cutText?: number }

/** A Windows path also appears without its drive (measured: an OpenCode tool title), and with `/` for `\` */
function variants(p: string): string[] {
  const forms = [p, p.replace(/^[A-Za-z]:[\\/]/, '')]
  return [...new Set(forms.flatMap((x) => [x, x.replace(/\\/g, '/'), x.replace(/\\/g, '\\\\')]))].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)
}

/** Where in `s` something must be replaced, earliest first and never overlapping */
function spans(s: string, places: Places): { start: number; end: number; with: string }[] {
  const found: { start: number; end: number; with: string }[] = []
  const literal = (needle: string, replacement: string) => {
    for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) found.push({ start: i, end: i + needle.length, with: replacement })
  }
  // The most specific first: the working folder sits inside the temp folder, which sits inside the home folder
  for (const v of variants(places.cwd)) literal(v, '<cwd>')
  for (const v of variants(places.tmp)) literal(v, '<tmp>')
  for (const v of variants(places.home)) literal(v, '<home>')
  // Claude Code files a project under its path with every other character a hyphen
  for (const [path, replacement] of [[places.cwd, '<cwd-slug>'], [places.tmp, '<tmp-slug>'], [places.home, '<home-slug>']] as const) {
    if (/[\\/]/.test(path) && path.length > 8) literal(path.replace(/[^A-Za-z0-9]/g, '-'), replacement)
  }
  const pattern = (re: RegExp, replacement: string) => {
    for (const m of s.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, with: replacement })
  }
  for (const [re, replacement] of FOREIGN) pattern(re, replacement)
  for (const m of s.matchAll(RECORDER_FOLDER)) found.push({ start: m.index, end: m.index + m[0].length, with: m[0].slice(0, -7) })
  if (places.user.length >= 3) pattern(new RegExp(`\\b${places.user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<user>')
  if (places.uuid) for (const m of s.matchAll(UUID_ANYWHERE)) found.push({ start: m.index, end: m.index + m[0].length, with: places.uuid(m[0].toLowerCase()) })
  pattern(SECRET, '<secret>')
  pattern(EMAIL, '<email>')
  // Earliest first, the longest where two start together; one that overlaps a kept one is dropped
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: typeof found = []
  for (const f of found) if (!kept.length || f.start >= kept.at(-1)!.end) kept.push(f)
  return kept
}

/** `pieces` scrubbed as the one text they make, each kept where it was: a replacement goes in the piece it starts in */
export function scrubPieces(pieces: readonly string[], places: ScrubPlaces, json = false): string[] {
  const all = withDefaults(places)
  const joined = pieces.join('')
  const found = spans(joined, all)
  const { slashes, drops } = separatorsAfterFolders(joined, found, json)
  const out: string[] = []
  let at = 0
  let next = 0
  for (const piece of pieces) {
    const end = at + piece.length
    let text = ''
    for (let i = at; i < end; i++) {
      while (next < found.length && found[next]!.end <= i) next++
      const f = found[next]
      if (f && i >= f.start && i < f.end) {
        if (i === f.start) text += f.with
        continue
      }
      if (drops.has(i)) continue
      text += slashes.has(i) ? '/' : joined[i]
    }
    out.push(text)
    at = end
  }
  return out
}

/**
 * A path under a placeholder folder as a Linux machine would write it, whatever the recording machine's separator: where, in
 * `joined`, a backslash that follows `<cwd>`, `<tmp>` or `<home>` in a path is a `/` (a doubled one, as JSON text escapes it, is one `/`).
 * Read over the joined text, so a path cut between two chunks is still one path. `json`: the text is JSON (a tool input
 * streamed as it is written), where a path's separator is the escaped pair `\\\\` and a single backslash starts an escape
 * (`\"`, `\n`), which stays as it is
 */
function separatorsAfterFolders(joined: string, found: readonly { start: number; end: number; with: string }[], json: boolean): { slashes: Set<number>; drops: Set<number> } {
  const slashes = new Set<number>()
  const drops = new Set<number>()
  const starts = new Map(found.map((f) => [f.start, f]))
  for (const folder of found) {
    if (!/^<(?:cwd|tmp|home)>$/.test(folder.with) || (joined[folder.end] !== '\\' && joined[folder.end] !== '/')) continue
    for (let i = folder.end; i < joined.length; ) {
      const span = starts.get(i)
      if (span) {
        i = span.end
        continue
      }
      const c = joined[i]!
      if (/[\s"'`<>|*?:]/.test(c)) break
      if (c === '\\') {
        const second = joined[i - 1] === '\\' && (slashes.has(i - 1) || drops.has(i - 1))
        // In JSON a lone backslash is an escape; only the pair is a separator
        if (json && !second && joined[i + 1] !== '\\') {
          i++
          continue
        }
        ;(second ? drops : slashes).add(i)
      }
      i++
    }
  }
  return { slashes, drops }
}

type Places = Required<Omit<ScrubPlaces, 'uuid'>> & Pick<ScrubPlaces, 'uuid'>

function withDefaults(p: ScrubPlaces): Places {
  return { cwd: p.cwd, home: p.home ?? homedir(), tmp: p.tmp ?? tmpdir(), user: p.user ?? safeUser(), ...(p.uuid ? { uuid: p.uuid } : {}) }
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export function scrub(frames: readonly Frame[], cwd: string, home: string = homedir(), more: ScrubOptions = {}): unknown[] {
  const { cutText, ...rest } = more
  const ids = new Map<string, string>()
  const counters: Record<string, number> = {}
  const stable = (kind: string, value: string) => {
    if (new RegExp(`^${kind}-\\d+$`).test(value)) return value
    const key = `${kind}:${value}`
    if (!ids.has(key)) ids.set(key, `${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`)
    return ids.get(key)!
  }
  // Claude Code's ids keep their shape: the adapter tells a UUID from other text, and its own inputs by their mark
  const numbered = (kind: string, value: string): string => {
    const key = `${kind}:${value}`
    if (!ids.has(key)) ids.set(key, String((counters[kind] = (counters[kind] ?? 0) + 1)))
    return ids.get(key)!
  }
  // One already a placeholder (a text scrubbed joined, then each piece again) is not numbered twice
  const placeholderId = (u: string): string => /^0{4}\d{4}-0000-4000-8000-/.test(u) ? u : `${numbered('uuid', u).padStart(8, '0')}-0000-4000-8000-${u.endsWith(CENTRALU_INPUT_MARK) ? CENTRALU_INPUT_MARK : numbered('tail', u).padStart(12, '0')}`
  // Ids in a streamed text are replaced where the text is scrubbed joined, so one cut across two chunks goes whole
  const places: ScrubPlaces = { cwd, home, ...rest, ...(rest.uuid ? {} : { uuid: placeholderId }) }
  const claudeIds = (s: string): string =>
    s
      .replace(UUID_ANYWHERE, (u) => placeholderId(u.toLowerCase()))
      // OpenCode's ids: `tool_…` names a tool output's file, and its leading digits are a time
      .replace(/\btool_[A-Za-z0-9]{16,}/g, (t) => `tool_${numbered('tool', t).padStart(6, '0')}`)
      .replace(/\btoolu_\w+/g, (t) => `toolu_${numbered('toolu', t).padStart(6, '0')}`)
      // A model response's items (Codex: `msg_`, `rs_` reasoning, `call_` and `fc_` tool calls) carry the provider's ids
      .replace(/^(msg|req|rs|call|fc|ws|resp)_\w+$/, (m, kind: string) => `${kind}_${numbered(kind, m).padStart(6, '0')}`)
      // The ids of a host's mailbox: the hub's (one per host) and a message's (a ULID)
      .replace(/\bhub-[0-9a-f]{8}\b/g, 'hub-00000001')
      .replace(/\bm_[0-9A-Z]{26}\b/g, (m) => `m_${numbered('mail', m).padStart(26, '0')}`)
  // A tool of the person's connectors is `mcp__<server>__<tool>`: both names are theirs; Centralu's own server, its apps' and the recorder's probe server are not
  const mcpNames = (s: string): string =>
    s.replace(/\bmcp__(.+?)__(\w+)/g, (all, server: string, tool: string) =>
      server === 'centralu' || server === 'probe' || server.startsWith('app-') || /^server-\d+$/.test(server) ? all : `mcp__${stable('server', server)}__${stable('tool', `${server}__${tool}`)}`,
    )
  // Of the commands, skills and agents only what ships with the CLI stays: the rest is the person's, and keeps its number
  const builtinCommands = new Set<string>()
  for (const f of frames) {
    const m = (f.msg ?? (f.line ? (JSON.parse(f.line) as unknown) : null)) as { response?: { response?: { commands?: unknown } }; commands?: unknown } | null
    for (const c of [...asList(m?.response?.response?.commands), ...asList(m?.commands)]) {
      if (c && typeof c === 'object' && 'builtin' in c && c.builtin === true && 'name' in c && typeof c.name === 'string') builtinCommands.add(c.name)
    }
  }
  const command = (name: string) => (builtinCommands.has(name) ? name : stable('command', name))
  const agent = (name: string) => (BUILTIN_AGENTS.has(name) ? name : stable('agent', name))
  const names = (list: unknown, pick: (name: string) => string) => (Array.isArray(list) ? list.map((n) => (typeof n === 'string' ? pick(n) : n)) : list)
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'sessionId' || key === 'subagentSessionId') return stable('ses', v)
      if (key === 'toolCallId') return stable('call', v)
      if (key === 'messageId') return stable('msg', v)
      if (key === 'request_id' && !/^req_/.test(v)) return stable('rid', v)
      if (key === 'serverName') return stable('server', v)
      // Codex: the account's plan, which says more of the person than the recording needs
      if (key === 'planType') return '<plan>'
      // Centralu's bridge, as the host puts it in a Codex thread's config: the program, its file, the host's address and the session's credential
      if (key === 'CC_BRIDGE_TOKEN' || key === 'CC_HOST_CREDENTIAL') return '<secret>'
      if (key === 'CC_HOST_URL') return 'ws://127.0.0.1:<port>'
      if (/centralu-bridge\.mjs$/.test(v)) return '<bridge>'
      if (key === 'command' && /(?:^|[\\/])node(?:\.exe)?$/.test(v)) return '<node>'
      // Codex: a thread's rollout file is named for the minute it began in local time, which says the time zone
      if (key === 'path' && /rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/.test(v)) return walk(v.replace(/rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, 'rollout-2000-01-01T00-00-00-'), 'rolloutPath')
      // Codex: the machine's system, as `initialize` answers with it
      if (key === 'userAgent') return v.replace(/\([^)]*\d+\.\d+[^)]*; [\w-]+\)/, '(<os>; <arch>)')
      if (key === 'signature' && v.length > 40) return '<signature>'
      const scrubbed = mcpNames(claudeIds(scrubPieces([v], places, key === 'partial_json')[0]!))
      // Cut after scrubbing: the start that stays has lost its paths and ids like the rest
      return cutText !== undefined && scrubbed.length > cutText ? `${scrubbed.slice(0, 200)}…<cut ${scrubbed.length - 200} characters>` : scrubbed
    }
    if (Array.isArray(v)) {
      // Size, not secrecy: the picture of the window as a grid, and the connectors' tools, are the bulk of a context reading and of the init lists
      if (key === 'gridRows' || key === 'mcpTools') return []
      if (key === 'tools') return v.filter((t) => typeof t !== 'string' || !t.startsWith('mcp__') || t.startsWith('mcp__centralu__') || t.startsWith('mcp__probe__') || t.startsWith('mcp__app-')).map((t) => walk(t))
      if (key === 'models') return v.slice(0, 3).map((m) => walk(m))
      if (key === 'commands' || key === 'agents' || key === 'skillFrontmatter') return v.map((item) => ownSetup(key, item, command, agent, walk))
      // Codex's `skills/list`: those of the CLI stay (scope `system`); the person's own (`user`, `repo`: from their home folder, a plugin, the project) keep a number and nothing else
      if (key === 'skills' && v.some((x) => x && typeof x === 'object' && 'scope' in x && 'path' in x)) {
        return v.map((item) => {
          const i = (item ?? {}) as Record<string, unknown>
          return i.scope === 'system' || typeof i.name !== 'string' ? walk(item) : { name: stable('skill', i.name), description: '', path: '<skill>', scope: i.scope, enabled: i.enabled, pluginId: null }
        })
      }
      return v.map((x) => walk(x, key === 'user_message_uuids' ? key : undefined))
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      // Antigravity: the account's plan, as `initialize` and `session/new` answer with it (`_meta.antigravity.tier`)
      if (key === 'tier' && typeof o.name === 'string') return { ...o, name: '<plan>', id: '<plan>', upgradeUri: '<url>' }
      if (key === 'account') return { email: '<email>', organization: '<organization>', subscriptionType: '<plan>', apiProvider: o.apiProvider }
      if (o.type === 'system' && o.subtype === 'init') {
        const plugins = asList(o.plugins).map((p) => (p && typeof p === 'object' && 'path' in p && p.path !== 'builtin' ? { name: stable('plugin', String((p as { name?: unknown }).name)), path: '<plugin>', source: '<plugin>' } : p))
        const servers = asList(o.mcp_servers).map((s) => (s && typeof s === 'object' ? { ...s, name: stable('server', String((s as { name?: unknown }).name)) } : s))
        const init = { ...o, slash_commands: names(o.slash_commands, command), terminal_slash_commands: names(o.terminal_slash_commands, command), skills: names(o.skills, command), agents: names(o.agents, agent), plugins, mcp_servers: servers }
        return Object.fromEntries(Object.entries(init).map(([k, x]) => [k, walk(x, k)]))
      }
      // An environment entry for a server the client starts (`mcpServers[].env`): a token's value is a secret
      if (typeof o.name === 'string' && typeof o.value === 'string' && /TOKEN|SECRET|PASSWORD|KEY/i.test(o.name)) return { ...o, value: '<secret>' }
      if (key === 'availableCommands' || o.sessionUpdate === 'available_commands_update') {
        const list = Array.isArray(o.availableCommands) ? o.availableCommands : []
        return { ...o, availableCommands: list.map((_c, i) => ({ name: `command-${i + 1}` })) }
      }
      // A name that is a path (Codex's `projects` trust map is keyed by folder) is a path like any other text
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [/[\\/]/.test(k) ? scrubPieces([k], places)[0]! : k, walk(x, k)]))
    }
    // Codex: how much of the account's allowance was used, and when it resets, are the person's, not the protocol's
    if (typeof v === 'number' && key === 'usedPercent') return 12
    if (typeof v === 'number' && key === 'resetsAt') return 1_800_000_000
    return v
  }
  const out: { t: number; dir: string; msg?: unknown; code?: number | null; signal?: string | null }[] = []
  for (const f of frames) {
    if (f.dir === 'stderr' || f.dir === 'note') continue
    if (f.dir === 'exit') {
      const m = (f.msg ?? {}) as { code?: number | null; sig?: string | null; signal?: string | null }
      out.push({ t: f.t, dir: 'exit', code: m.code ?? (f as { code?: number | null }).code ?? null, signal: m.sig ?? m.signal ?? (f as { signal?: string | null }).signal ?? null })
      continue
    }
    const msg = f.msg ?? (f.line ? JSON.parse(f.line) : f.raw ? JSON.parse(f.raw) : null)
    if (!msg) continue
    out.push({ t: f.t, dir: f.dir, msg })
  }
  rejoinChunks(out, places)
  return out.map((f) => (f.dir === 'exit' ? f : { ...f, msg: walk(f.msg) }))
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A command, skill or agent in the answer to `initialize`, `commands_changed` or a context reading: the person's own keep a number and nothing else */
function ownSetup(list: string, item: unknown, command: (n: string) => string, agent: (n: string) => string, walk: (v: unknown) => unknown): unknown {
  const i = (item ?? {}) as Record<string, unknown>
  if (typeof i.name !== 'string') return walk(item)
  const own = list === 'agents' ? !BUILTIN_AGENTS.has(i.name) : list === 'commands' ? i.builtin !== true : i.source !== 'built-in'
  // A built-in's long description is cut: the adapter reads names
  if (!own) return typeof i.description === 'string' && i.description.length > 60 ? walk({ ...i, description: `${i.description.slice(0, 57)}...` }) : walk(item)
  return list === 'agents' ? { name: agent(i.name), description: '' } : list === 'commands' ? { name: command(i.name), description: '', builtin: false } : { name: command(i.name), source: 'user', tokens: i.tokens }
}

type Chunk = { kind: string; session: string; holder: Record<string, string>; field: string }

/** The text of a streamed chunk frame, by reference, so it can be written back */
function chunkOf(msg: unknown): Chunk | null {
  const acp = msg as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: unknown } } } } | null
  if (acp?.method === 'session/update') {
    const u = acp.params?.update
    if (!u?.sessionUpdate || !CHUNKED.has(u.sessionUpdate) || u.content?.type !== 'text' || typeof u.content.text !== 'string') return null
    return { kind: u.sessionUpdate, session: String(acp.params?.sessionId ?? ''), holder: u.content as Record<string, string>, field: 'text' }
  }
  // Codex's app-server: the text of an item, in notifications of its own
  const codex = msg as { method?: string; params?: { threadId?: string; itemId?: string; summaryIndex?: number; contentIndex?: number; delta?: unknown } } | null
  if (codex?.method && /^item\/.*delta$/i.test(codex.method) && typeof codex.params?.delta === 'string') {
    return { kind: codex.method, session: `${codex.params.threadId}:${codex.params.itemId}:${codex.params.summaryIndex ?? ''}:${codex.params.contentIndex ?? ''}`, holder: codex.params as Record<string, string>, field: 'delta' }
  }
  const claude = msg as { type?: string; event?: { type?: string; index?: number; delta?: Record<string, unknown> }; api_message_id?: string } | null
  const delta = claude?.type === 'stream_event' && claude.event?.type === 'content_block_delta' ? claude.event.delta : undefined
  const field = typeof delta?.type === 'string' ? DELTA_FIELDS[delta.type] : undefined
  if (!delta || !field || typeof delta[field] !== 'string') return null
  return { kind: String(delta.type), session: `${claude?.api_message_id ?? ''}:${claude?.event?.index ?? ''}`, holder: delta as Record<string, string>, field }
}

/** Each run of consecutive chunks of one kind is scrubbed as one text (`scrubPieces`), in place */
function rejoinChunks(frames: readonly { dir: string; msg?: unknown }[], places: ScrubPlaces): void {
  let run: Chunk[] = []
  const flush = () => {
    if (run.length > 1) scrubPieces(run.map((c) => c.holder[c.field]!), places, run[0]!.field === 'partial_json').forEach((text, i) => (run[i]!.holder[run[i]!.field] = text))
    run = []
  }
  for (const f of frames) {
    // What the adapter sends meanwhile does not break a run of what the tool streams, nor do Claude Code's other messages (an answer to a
    // query, a status, a snapshot of the message): only a change of the streamed block does
    if (f.dir !== 'in') continue
    const c = chunkOf(f.msg)
    if (!c) {
      const type = (f.msg as { type?: unknown } | null)?.type
      if (typeof type === 'string' && type !== 'stream_event') continue
      flush()
      continue
    }
    if (run.length && (run[0]!.kind !== c.kind || run[0]!.session !== c.session)) flush()
    run.push(c)
  }
  flush()
}

const main = isMain(import.meta.url)
if (main && process.argv[2] === '--rescrub') {
  // A committed fixture's paths were scrubbed already; what this pass adds is the rest (chunks, foreign folders, the user)
  for (const file of process.argv.slice(3)) {
    const [head, ...lines] = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const frames = lines.map((l) => JSON.parse(l) as Frame)
    writeFileSync(file, [head, ...scrub(frames, '<cwd>').map((l) => JSON.stringify(l))].join('\n') + '\n')
    console.log(`rescrubbed ${file}`)
  }
} else if (main) {
  const [input, output] = process.argv.slice(2)
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const cwd = flag('cwd')
  if (!input || !output || !cwd || !flag('tool') || !flag('version') || !flag('scenario')) {
    console.error('usage: frames-scrub.mts <raw.jsonl> <out.jsonl> --tool <name> --version <v> --scenario <name> --cwd <path>')
    process.exit(2)
  }
  const frames = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame)
  const header = { header: { tool: flag('tool'), version: flag('version'), scenario: flag('scenario'), protocolVersion: 1, os: process.platform, recorded: new Date().toISOString().slice(0, 10) } }
  writeFileSync(output, [header, ...scrub(frames, cwd)].map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(`wrote ${output}`)
}
