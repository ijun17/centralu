import type { ApprovalDecision, ApprovalDetail, PermissionPreset } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { AlwaysAllowRules, alwaysAllowKey } from '../always-allow.js'
import type { EventSink } from '../contract.js'
import { insideFolder, realPathOf } from '../edit-grant.js'
import { pathsOf as hostPaths } from '../../os.js'
import { fileEditDetail } from '../file-changes.js'
import { CardIds, PendingCards } from '../session-kit.js'
import { deniedBy, rulePaths, type DenyRule, type RuleTarget } from './deny-rules.js'
import type { GateAnswer } from './gate-answer.mjs'
import { CENTRALU_SERVER, PLUGIN_NAME } from './plugin-root.js'
import { mcpServer, pathsOf, toolKind, type AgyToolKind } from './tool-kinds.js'

/**
 * The host's end of the `agy` gate (docs/plans/antigravity-adapter.md §5): one `PreToolUse` hook call in, one decision
 * out. The hook (`agy-gate.mjs`) posts the call here through the gate's route and prints what this returns.
 *
 * **No new decision order.** What is allowed without a card is the order the ACP adapter uses
 * (`AcpSession.grantedWithoutCard`): `auto`, Centralu's own tool, an `edits` grant inside the folder (`edit-grant.ts`),
 * a saved "always" rule (`always-allow.ts`). `agy` asks the gate about every call, reads included, where an ACP agent
 * asks only about what its own rules flag, so the reads the other tools let through on their own (Claude's `default`
 * mode, an ACP agent's own policy) are let through here by the preset, and the rest gets a card. Two refusals come
 * first, since nothing may allow past them: a write into the session's plugin root, and the person's own `agy` deny
 * rules (`deny-rules.ts`; deny only).
 *
 * A tool `tool-kinds.ts` does not know (`other`) is a card under every preset, `auto` included: `init.tools` does not
 * list every tool (measured), and a new one must not slip through.
 */

/** A call as the gate reads it: its kind (`tool-kinds.ts`), the paths it names, the MCP server it calls */
type ToolClass = { kind: AgyToolKind; paths: string[]; server: string }

const classifyTool = (name: string, args: Record<string, unknown>): ToolClass => ({ kind: toolKind(name), paths: pathsOf(args), server: mcpServer(args) })

/** The hook's input as `agy` sends it (measured, §1.2), read leniently */
export type HookCall = { conversationId?: string; stepIdx?: number; name: string; args: Record<string, unknown>; workspacePaths: string[] }

export type AgyGateDeps = {
  sessionId: string
  /** The session's folder */
  cwd: string
  /** The session's plugin root (`writePluginRoot`): a write there is refused */
  pluginRoot: string
  preset: PermissionPreset
  emit: EventSink
  /** The person's `agy` deny rules (`readDenyRules`), read once when the session starts */
  denyRules?: readonly DenyRule[]
  /** Folders a `normal` session may read beside its own (`CreateSessionOpts.readableDirs`) */
  readableDirs?: readonly string[]
  /** Paths given to read after the start (`CreateSessionOpts.mayRead`) */
  mayRead?: (path: string) => boolean
  /**
   * `agy`'s folder of MCP tool descriptors (`agyMcpDescriptors`): the model reads a tool's descriptor there before each
   * MCP call (measured), so without this every use of Centralu's own tools would first raise a card for a read outside
   * the folder. The files are tool schemas `agy` writes itself
   */
  mcpDescriptors?: string
  /** A path through its links (the deepest part that exists, the rest put back), null when it cannot be resolved; `edit-grant.ts`'s by default */
  realPath?: (path: string) => Promise<string | null>
}

const path = hostPaths()

export const DECLINED = 'The person declined.'
export const STOPPED = 'The turn was stopped.'
export const CLOSING = 'The session is closing.'

type Card = { answer(a: GateAnswer): void }

export class AgyGate {
  private preset: PermissionPreset
  private readonly rules = new AlwaysAllowRules()
  private readonly cards = new PendingCards<Card>()
  private readonly cardIds = new CardIds()
  /** Set by `stop`: every call is refused with it until `resume` (a Stop's turn may ask once more before it ends) */
  private refusing: string | null = null
  /** Counts the Stops: a call that began before one is refused even when `resume` came before it was decided */
  private stops = 0
  /** The deny rules' paths resolved through links, once */
  private rulePathsReal: Promise<Map<string, string>> | null = null

  constructor(private readonly deps: AgyGateDeps) {
    this.preset = deps.preset
  }

  /** The number of cards waiting for the person */
  get open(): number {
    return this.cards.size
  }

  /**
   * The decision for one hook call. Never throws. A card waits until the person answers, `stop` or `close` runs, or
   * `signal` aborts (the hook went away: its connection closed, `agy` killed it).
   */
  async answer(input: unknown, signal?: AbortSignal): Promise<GateAnswer> {
    try {
      return await this.decide(input, signal)
    } catch {
      return deny('Centralu could not check this call, so it was not run.')
    }
  }

  private async decide(input: unknown, signal?: AbortSignal): Promise<GateAnswer> {
    if (this.refusing) return deny(this.refusing)
    const stops = this.stops
    const stopped = () => this.refusing ?? (this.stops !== stops ? STOPPED : null)
    const call = readHookCall(input)
    if (!call) return deny('Centralu could not read this call, so it was not run.')
    const tool = classifyTool(call.name, call.args)
    const target = ruleTarget(tool, call, this.deps.cwd)
    if (await this.writesPluginRoot(target)) return deny(`Centralu does not allow writes into its ${PLUGIN_NAME} plugin folder.`)
    const rule = deniedBy(this.deps.denyRules ?? [], target, await this.realRulePaths(target))
    if (rule) return deny(`A deny rule in the person's agy settings blocks this call: ${rule.text}`)
    const granted = await this.grantedWithoutCard(tool, call, target)
    // A Stop may have come while the paths were being checked, and the next turn begun after it
    const stop = stopped()
    if (stop) return deny(stop)
    if (granted) return ALLOW
    if (signal?.aborted) return deny(STOPPED)
    return this.raiseCard(detailOf(tool, call, this.deps.cwd), signal)
  }

  /** The ACP adapter's order (`grantedWithoutCard`), then the reads each preset lets through on its own (§5.2) */
  private async grantedWithoutCard(tool: ToolClass, call: HookCall, target: RuleTarget): Promise<boolean> {
    if (tool.kind === 'other') return false
    // A path `agy` may expand (`~`, `$HOME`, `%USERPROFILE%`, `file://`) is not checked as written: a card
    if (tool.paths.some((p) => !plainPath(p))) return false
    if (this.preset === 'auto' || centraluTool(tool)) return true
    // A sub-agent's own calls pass this gate one by one (measured), so starting one asks only under `safe`
    if (tool.kind === 'subagent') return this.preset !== 'safe'
    if (this.preset === 'edits' && tool.kind === 'edit' && EDITS_GRANT.has(call.name) && target.writes?.length) {
      if (await insideFolder(this.deps.cwd, target.writes)) return true
    }
    // A rule names one file: a card over several files is never allowed by the first one's rule
    const detail = detailOf(tool, call, this.deps.cwd)
    const key = detail.kind === 'file_edit' && detail.multi ? '' : alwaysAllowKey(detail)
    if (key !== '' && this.rules.allows(key)) return true
    if (tool.kind === 'read') return (await this.readsDescriptors(target.reads ?? [])) || this.readAllowed(target.reads ?? [])
    return false
  }

  /** Reads of MCP tool descriptors only, under every preset */
  private async readsDescriptors(paths: readonly string[]): Promise<boolean> {
    const dir = this.deps.mcpDescriptors
    if (!dir || paths.length === 0) return false
    for (const p of paths) if (!(await this.insideThroughLinks([dir], p))) return false
    return true
  }

  /** `safe`: reads inside the session's folder; `normal` and `edits`: also the readable folders and paths given later */
  private async readAllowed(paths: readonly string[]): Promise<boolean> {
    if (paths.length === 0) return false
    const roots = this.preset === 'safe' ? [this.deps.cwd] : [this.deps.cwd, ...(this.deps.readableDirs ?? [])]
    for (const p of paths) {
      if (this.preset !== 'safe' && this.deps.mayRead?.(p)) continue
      if (!(await this.insideThroughLinks(roots, p))) return false
    }
    return true
  }

  private real(path: string): Promise<string | null> {
    return (this.deps.realPath ?? realPathOf)(path).catch(() => null)
  }

  /** For an allow: whether `path`, through its links, is inside one of `roots` taken the same way (a link out is outside) */
  private async insideThroughLinks(roots: readonly string[], path: string): Promise<boolean> {
    const real = await this.real(path)
    if (real === null) return false
    for (const root of roots) {
      const rootReal = await this.real(root)
      if (rootReal !== null && contains(rootReal, real)) return true
    }
    return false
  }

  /** For a refusal: whether a write names the plugin root, as written or through links */
  private async writesPluginRoot(target: RuleTarget): Promise<boolean> {
    const root = this.deps.pluginRoot
    const rootReal = await this.real(root)
    for (const p of target.writes ?? []) {
      const real = await this.real(p)
      for (const r of [root, rootReal]) for (const q of [p, real]) if (r !== null && q !== null && contains(r, q)) return true
    }
    return false
  }

  private async realMap(paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const p of paths) {
      const real = await this.real(p)
      if (real !== null) out.set(p, real)
    }
    return out
  }

  private async realRulePaths(target: RuleTarget): Promise<Map<string, string>> {
    this.rulePathsReal ??= this.realMap(rulePaths(this.deps.denyRules ?? []))
    const known = await this.rulePathsReal
    const paths = [...(target.reads ?? []), ...(target.writes ?? [])]
    if (paths.length === 0) return known
    return new Map([...known, ...(await this.realMap(paths))])
  }

  private raiseCard(detail: ApprovalDetail, signal?: AbortSignal): Promise<GateAnswer> {
    const requestId = this.cardIds.next('agy-req')
    return new Promise<GateAnswer>((resolve) => {
      const onAbort = () => this.close(requestId, deny(STOPPED))
      this.cards.set(requestId, {
        answer: (a) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(a)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.deps.emit({ type: 'approval_request', sessionId: this.deps.sessionId, requestId, detail })
    })
  }

  /** The person's answer to a card; false when it is no longer open */
  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: unknown, matcher?: string): boolean {
    const card = this.cards.take(requestId)
    if (!card) return false
    // "Always" stays Centralu's rule (#838): nothing is written to the person's agy permissions
    if (decision === 'always' && matcher) this.rules.add(matcher)
    card.answer(decision === 'deny' ? deny(DECLINED) : ALLOW)
    this.deps.emit({ type: 'approval_resolved', sessionId: this.deps.sessionId, requestId, decision })
    return true
  }

  applyRules(matchers: readonly string[]): void {
    this.rules.addAll(matchers)
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.preset = preset
  }

  /**
   * Answers every open card `deny` and refuses each call after it until `resume`. A Stop calls this **before** it
   * sends SIGINT: `agy` does not act on SIGINT while a hook runs (measured: 97 s, until the hook ended), and with the
   * requests denied first it exits within about a second (§1.5, §3.3).
   */
  stop(reason: string = STOPPED): void {
    this.refusing = reason
    this.stops++
    this.cards.release((requestId, card) => {
      card.answer(deny(reason))
      this.deps.emit({ type: 'approval_resolved', sessionId: this.deps.sessionId, requestId, decision: 'deny' })
    })
  }

  /** The next turn may ask again */
  resume(): void {
    this.refusing = null
  }

  private close(requestId: string, a: GateAnswer): void {
    const card = this.cards.take(requestId)
    if (!card) return
    card.answer(a)
    this.deps.emit({ type: 'approval_resolved', sessionId: this.deps.sessionId, requestId, decision: 'deny' })
  }
}

/**
 * A Stop of an `agy` turn: every open gate request is denied first, then the process gets SIGINT (`interrupt`). The
 * other order hangs until the hook's own timeout (§1.5).
 */
export function stopTurn(gate: AgyGate, interrupt: () => void): void {
  gate.stop(STOPPED)
  interrupt()
}

const ALLOW: GateAnswer = { decision: 'allow' }

/**
 * The edit tools the `edits` grant answers: they write the text they are given. `sed_file` runs GNU sed, whose `e` and
 * `w` commands run a command and write another file, so it is a card like a command
 */
const EDITS_GRANT = new Set(['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content'])

/** A path the gate can check as written: no home or variable to expand, no URL */
const plainPath = (p: string): boolean => !/^~|\$|%|:\/\//.test(p)
const deny = (reason: string): GateAnswer => ({ decision: 'deny', reason })

/** The hook's JSON (`{conversationId, stepIdx, toolCall: {name, args}, workspacePaths, …}`), or null when it has no tool name */
export function readHookCall(input: unknown): HookCall | null {
  const o = asObj(input)
  const toolCall = asObj(o.toolCall)
  const name = typeof toolCall.name === 'string' ? toolCall.name : ''
  if (!name) return null
  return {
    ...(typeof o.conversationId === 'string' ? { conversationId: o.conversationId } : {}),
    ...(typeof o.stepIdx === 'number' ? { stepIdx: o.stepIdx } : {}),
    name,
    args: asObj(toolCall.args),
    workspacePaths: Array.isArray(o.workspacePaths) ? o.workspacePaths.filter((p): p is string => typeof p === 'string') : [],
  }
}

/** The server name `agy` gives Centralu's own MCP server in the plugin (measured: `<plugin>_<server>`) */
const OWN_SERVER = `${PLUGIN_NAME}_${CENTRALU_SERVER}`

function centraluTool(tool: ToolClass): boolean {
  return tool.kind === 'mcp' && tool.server === OWN_SERVER
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What an execute call runs or types: the command line, or the input sent to a running one */
const commandOf = (call: HookCall): string => str(call.args.CommandLine) || str(call.args.Command) || str(call.args.command) || str(call.args.Input)

/** What the deny rules and the folder checks read of a call: absolute paths, resolved against the session's folder */
function ruleTarget(tool: ToolClass, call: HookCall, cwd: string): RuleTarget {
  const abs = tool.paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)))
  switch (tool.kind) {
    case 'read':
      return { reads: abs }
    case 'edit':
      return { writes: abs }
    case 'execute':
      return { command: commandOf(call) }
    case 'mcp':
      return { mcp: { server: tool.server, tool: str(call.args.ToolName) } }
    case 'subagent':
      return {}
    default: {
      // Any other tool: every path it names is taken for a write too, so a rule or the plugin root can refuse it; a URL
      // is a read for `read_url_content` and an action on the page for the browser's tools
      const urls = [str(call.args.Url), str(call.args.URL), str(call.args.url)].filter(Boolean)
      const web = call.name === 'read_url_content' ? { readUrls: urls } : { executeUrls: urls }
      return { reads: abs, writes: abs, ...web }
    }
  }
}

/** The card for a call, by its kind */
export function detailOf(tool: ToolClass, call: HookCall, cwd: string): ApprovalDetail {
  if (tool.kind === 'execute') {
    const command = commandOf(call)
    return { kind: 'command', command, cwd: str(call.args.Cwd) || cwd, ...(call.name === 'send_command_input' ? { stdin: true } : {}) }
  }
  if (tool.kind === 'edit' && tool.paths.length > 0) {
    const diff = str(call.args.Content) || str(call.args.CodeContent) || str(call.args.ReplacementContent)
    return fileEditDetail(tool.paths.map((p) => ({ path: path.isAbsolute(p) ? p : path.resolve(cwd, p), diff })))
  }
  const summary = str(call.args.toolSummary)
  return { kind: 'other', raw: JSON.stringify({ tool: call.name, args: call.args }).slice(0, 2000), ...(summary ? { about: summary } : {}) }
}

/** Whether `path` is `root` or inside it, by path segment */
function contains(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p))
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}
