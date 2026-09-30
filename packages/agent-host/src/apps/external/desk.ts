import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv'
import { z } from 'zod'
import type { BrokerCall, BrokerToolName } from './broker.js'
import {
  HOST_CAPABILITIES,
  capabilityKey,
  hostCapabilityText,
  isHostCapability,
  usesStamp,
  type Capability,
  type CapabilityBook,
  type HostCapability,
} from './capabilities.js'
import type { AppManifest } from './manifest.js'
import type { AppRef } from './ref.js'
import { FAILURES_KEPT, describeArgs, type AgentTokens, type AppRunRow, type RunLedger } from './runs.js'

/**
 * The broker desk (M4 D) — the **one place** that resolves what an app requests over fd 3.
 *
 * Once the gatekeeper (`broker.ts`) checks only "is there a run currently open for this pipe's app"
 * and hands it off, this is where a single request is fully processed: did the manifest declare it
 * (`uses`), what resolves it (each tool's own body), and what gets returned. A declaration is not a
 * grant — anything not declared is refused before it ever reaches the body (treating an absent
 * declaration as "everything" would be dangerous, see manifest.ts).
 *
 * The part of the body that only the host's core can do (starting an agent session) is received
 * through `BrokerHost`. The runtime knows nothing about sessions
 * (`host-app-runtime-physics-only`) — the shape needed is declared here, and the manager fills it in
 * when it receives the runtime (`useExternalApps`).
 */

/** A requesting app — the app the pipe identified, and the manifest read when its process started */
export type DeskApp = {
  ref: AppRef
  /** The name a person reads (the manifest's `name`) */
  name: string
  manifest: AppManifest
}

/** One agent run an app requested (D-1) — the shape the desk hands to the host after checking the declaration and the tool */
export type AgentRunRequest = {
  app: AppRef
  appName: string
  /** The tool the desk chose — one the manifest allows */
  tool: string
  prompt: string
  /** The shape of the answer (JSON Schema, an object at the root). If present, this makes the tool produce structured output */
  schema?: Record<string, unknown>
}

export type AgentRunResult = {
  /** The session that received this request — a new one is created for every request */
  sessionId: string
  /** The final answer of the turn (the text after the last tool call). Empty text if there was none */
  text: string
  /** Structured output the tool supplied separately as the turn's outcome (Claude) — undefined if absent (for Codex, the last text is that JSON) */
  output?: unknown
}

/**
 * What the desk asks of the runtime — the app list, and the single path for calling an app's tool
 * (`ExternalApps.call`). It receives only these two so it never has to look inside the runtime: a
 * call between apps (D-2) also has to pass through the same path a screen's or a session's call does
 * (audience, run id, cancellation, the ledger).
 */
export type DeskApps = {
  /** Whether an app with this name is in the list — this also includes an app with an invalid manifest or an untrusted project's app (calling it gets refused with that reason) */
  has(ref: AppRef): boolean
  /** The name a person reads for an app — the manifest's `name`, or the id if absent */
  name(ref: AppRef): string
  /** A function that masks this app's stored secrets — arguments and reasons written to the ledger (D-6) are masked by the same rule as a tool call's own record */
  redactor(ref: AppRef): (text: string) => string
  /**
   * The chain leading up to this run (D-5) — from the call that started the chain to this run, with
   * one of an app's tool calls as one hop. Runaway prevention checks depth and repetition against
   * this.
   */
  chain(runId: string): { ref: AppRef; tool: string }[]
  /**
   * **Who started** the chain this run belongs to (D-4) — walking up through parents to the first
   * caller that is not an app. If it is a session, the question is attributed to that session; if a
   * screen, to that app's fixed screen. Returns null if the chain can no longer be followed (the
   * parent has already ended).
   */
  origin(runId: string): CapabilityOrigin | null
  /**
   * The person denied this run's request (D-4) — either they pressed Deny right there, or it is a
   * remembered denial. If the requesting app's tool fails because of this, that failure is not a bug
   * in the app, it is the person's decision: the runtime records it in the error bundle so the screen
   * can state it that way (alongside C-6).
   */
  denied(runId: string, denial: CapabilityDenial): void
  call(
    ref: AppRef,
    tool: string,
    args: Record<string, unknown>,
    caller: { kind: 'app'; parentRunId: string },
    opts: { signal: AbortSignal },
  ): Promise<{ status: string; result: CallToolResult | null; error: string | null }>
}

/** One capability the person denied — which app tried to do what (the exact wording shown in the question). The place to reverse it is that app's runs panel */
export type CapabilityDenial = { app: AppRef; name: string; capability: string; text: string }

/** Where a question is attributed — the session that started the chain, or the app of the screen that started it */
export type CapabilityOrigin = { kind: 'session'; sessionId: string } | { kind: 'view'; app: AppRef }

/** One thing asked of the person (D-4) — built by the desk and handed to the host */
export type CapabilityQuestion = {
  /** The app that wants to use the capability */
  app: AppRef
  appName: string
  /** The memory key (`capabilityKey`) */
  capability: string
  /** What it wants to do — "run an agent (Claude Code) in a new session" */
  text: string
  origin: CapabilityOrigin
  /**
   * When it was asked. Comes from **the same clock read** as the expiry — if the receiving side read
   * `Date.now()` separately instead, the 1ms drift between the two would turn a "5-minute question"
   * into 4 minutes 59.999 seconds (a test occasionally caught exactly that).
   */
  askedAt: number
  /** If there is no answer by this time, the desk closes it as a denial */
  expiresAt: number
}

/** The part of the broker's body the host's core fills in */
export type BrokerHost = {
  /** The default agent tool for this scope — the project's default tool for a project app, the orchestrator's tool for a user-folder app */
  defaultAgentTool(projectId: string | null): string
  /**
   * Sends the request to a new session and waits for the turn to end. If the signal fires, stops the
   * session (an interrupt). If the tool is unavailable (not installed, not logged in), throws with a
   * reason — that reason is exactly the message the app receives.
   */
  runAgent(
    req: AgentRunRequest,
    ctx: {
      signal: AbortSignal
      progress(message: string): void
      /** Once, the moment the session exists — so a run visible in the ledger (D-6) can already cross over to that session */
      onSession(sessionId: string): void
      /** The cumulative token count the tool reported for this run — called every time it reports. The last one reported is what ends up in the ledger (D-5) */
      onUsage(tokens: AgentTokens): void
    },
  ): Promise<AgentRunResult>
  /**
   * Reads one piece of host data (D-3). Called only after the desk has already checked the name
   * (against the closed list) and the declaration. The app decides the scope: a project app gets that
   * project, a user-folder app gets the whole user. If it cannot be given (a user-folder app asking
   * for git.status), this throws with a reason.
   */
  hostData(name: HostCapability, app: AppRef): Promise<Record<string, unknown>>
  /** The human-readable name of an agent tool — written into the question ("Claude Code") */
  agentLabel(tool: string): string
  /**
   * Asks the person (D-4) — through that session's approval card if the chain started from a
   * session, or on that app's fixed screen if it started from a screen. If the signal fires (time
   * ran out, the request was cancelled), withdraws the question and resolves with null. Remembering
   * the answer is the desk's job.
   */
  askCapability(q: CapabilityQuestion, signal: AbortSignal): Promise<'allow' | 'deny' | null>
}

/**
 * The text cap for one request. Text an app hands over stays in the session's conversation verbatim
 * and fills the agent's context on every turn — anything longer than this is not text, it is data,
 * and data belongs in a file instead. 200,000 characters is roughly 50,000 tokens, comfortably inside
 * both tools' context windows.
 */
export const AGENT_PROMPT_MAX_CHARS = 200_000
/** The schema cap — 64KiB is plenty to describe one answer shape. Anything larger is data, not a schema */
export const AGENT_SCHEMA_MAX_BYTES = 64 * 1024

/**
 * Runaway prevention (M4 D-5) — an app is code, and a loop in code runs hundreds of times before a
 * person ever sees it. Apps calling each other, or starting agents without end, would spend the
 * person's machine and usage. So this is what the broker counts:
 *
 *   chain depth  an app call chain goes at most 3 hops — the app a screen (or session) calls is hop
 *                1, the app that app calls is hop 2, the app that one calls is hop 3. "The screen's
 *                app → an app that does the work → an app that supplies data" is the longest
 *                combination we design for. A chain deeper than that is more often a loop than a
 *                design, and every hop can start an agent and hold a person's call open. It is a
 *                constant, so it is easy to raise
 *   repetition   if the same (app, tool) appears again within one chain, it is refused — A.t → B.x →
 *                A.t is already a loop before it ever reaches the depth cap
 *   agent        at most one per app at a time, five within a minute. Measured: the shortest run (a
 *                one-sentence answer from haiku) took 4.0 seconds, one given a schema took 5.6
 *                seconds — even run one after another, the ceiling is 11 to 15 per minute. Five is
 *                enough that a burst of a few short requests never hits it, while a loop is stopped
 *                at five per minute (300 per hour), and the refusal shows up in the runs panel with
 *                its reason. If there is a lot of work, it is told to fit into one request
 *
 * Why a second agent is refused instead of queued: a queue is an invisible wait. An app's call would
 * be held silently for minutes, and a loop would only pile the queue higher. A refusal reaches the
 * app immediately, with a reason — the app can wait for the first one to finish and ask again.
 */
export const CHAIN_DEPTH_MAX = 3
export const AGENT_RUNS_PER_WINDOW = 5

const CallAppArgs = z.object({
  app: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
})

/**
 * A name an app calls another app by → the app (D-2). Same shape as the rule sessions use to resolve
 * an app (decision 4): a project app calls **its own project's app first**, and the user-folder app
 * of the same name if that does not exist. A user-folder app can call only other user-folder apps —
 * since it belongs to no project, there is no basis for picking any one project's app. An app in a
 * different project is never reachable even under the same name (trust differs per project).
 */
export function resolveCallTarget(asker: AppRef, id: string, has: (ref: AppRef) => boolean): AppRef | null {
  if (asker.projectId !== null) {
    const same = { projectId: asker.projectId, appId: id }
    if (has(same)) return same
  }
  const user = { projectId: null, appId: id }
  return has(user) ? user : null
}

const HostDataArgs = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })

const RunAgentArgs = z.object({
  prompt: z.string(),
  tool: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
})

/** The visible shape of one remembered answer (`apps.permissions`) */
export type CapabilityDecisionListed = { capability: string; text: string; decision: 'allow' | 'deny'; decidedAt: number; current: boolean }

/** The text of a denial — this goes both into the app's result and its stderr. Also states how to reverse it */
function deniedText(tool: BrokerToolName, appName: string, text: string): string {
  return `${tool} refused: the person did not allow ${appName} to ${text}. They can change this in the app's Runs panel (Permissions → Forget), and Centralu asks again when the app's manifest changes what it uses.`
}

/** The slot name for one app — runaway prevention counts per app under this */
const slotOf = (ref: AppRef): string => `${ref.projectId ?? '_user'}/${ref.appId}`

/** A duration for a person to read — "5 minutes", "1 second" */
function humanDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'}`
}

const NOT_DECLARED = 'this app did not declare "uses": { "agent": … } in centralu.app.json — an app may run an agent only if its manifest says so'

/**
 * One answer from the desk — the result to return to the app, and the outcome to record in the
 * ledger (D-6). `rejected` is policy blocking something (outside the declaration, not allowed by the
 * person, a limit), and `error` is the request being malformed or something going wrong while
 * resolving it (empty text, a bad schema, an agent failing). The runs panel shows these with
 * different words (refused / failed) — to someone fixing the app, "blocked" and "wrong" are
 * different things.
 *
 * `delegated` means call_app reached the called app. That app's own run row (caller kind `app`,
 * parent = the run that triggered this request) is already this request's record — the same event is
 * never written as two rows.
 */
type Answer = { status: 'ok' | 'error' | 'rejected' | 'delegated'; result: CallToolResult }

const say = (text: string): Answer => ({ status: 'ok', result: { content: [{ type: 'text', text }] } })
const refuse = (text: string): Answer => ({ status: 'rejected', result: { content: [{ type: 'text', text }], isError: true } })
const fail = (text: string): Answer => ({ status: 'error', result: { content: [{ type: 'text', text }], isError: true } })
const firstText = (r: CallToolResult): string => r.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? ''

/**
 * The ledger row for one broker request (D-6) — the requesting app's `broker` row, with its parent
 * being the run that triggered it. Kept in the same table as a tool call's row, under the same rules
 * (arguments as a masked summary and a hash, original text kept only for failures). So following one
 * app's ledger down from the root reads as a single chain: "the tool the screen pressed → the agent
 * the app requested".
 *
 * A row is created the first time it is needed (`open`) — for run_agent and host_data, as soon as the
 * request arrives (an agent can run for minutes, and a running row has to be visible), and for
 * call_app, only if it ends without ever reaching the called app (if it does reach it, that app's own
 * row is the record).
 */
class BrokerRow {
  readonly id = `run_${randomUUID()}`
  private readonly t0 = Date.now()
  private described: ReturnType<typeof describeArgs> | null = null
  private closed = false

  constructor(
    private ledger: RunLedger | null,
    private app: AppRef,
    private tool: BrokerToolName,
    private args: Record<string, unknown>,
    private parentRunId: string | null,
    private redact: (text: string) => string,
  ) {}

  open(): void {
    if (this.described || !this.ledger) return
    this.described = describeArgs(this.args, this.redact)
    this.ledger.begin({
      id: this.id,
      projectId: this.app.projectId,
      appId: this.app.appId,
      kind: 'broker',
      tool: this.tool,
      // The requester is this app — who started the chain comes from walking up through parents
      callerKind: 'app',
      callerSessionId: null,
      parentRunId: this.parentRunId,
      status: 'running',
      durationMs: null,
      argsDigest: this.described.digest,
      argsSummary: this.described.summary,
      error: null,
      createdAt: this.t0,
      sessionId: null,
    })
  }

  /** Links the agent session this request started — the moment the session exists, before it ends */
  link(sessionId: string): void {
    this.open()
    this.ledger?.link(this.id, sessionId)
  }

  /** Tokens the agent spent — overwritten every time the tool reports it (it is a cumulative value). Written when this closes */
  used: AgentTokens | null = null

  close(status: Exclude<AppRunRow['status'], 'running'>, error: string | null, result: CallToolResult | null = null): void {
    if (this.closed || !this.ledger) return
    this.closed = true
    this.open()
    this.ledger.end(this.id, { status, durationMs: Date.now() - this.t0, error: error === null ? null : this.redact(error), tokens: this.used })
    // The input (text, schema) of a failed request needs to be seen by the agent fixing the app — under the same rule as a tool call, keeping only the most recent
    if (status === 'error') {
      this.ledger.keepFailure(
        {
          runId: this.id,
          projectId: this.app.projectId,
          appId: this.app.appId,
          args: this.described!.json,
          result: result ? this.redact(JSON.stringify(result)) : null,
          createdAt: this.t0,
        },
        FAILURES_KEPT,
      )
    }
  }
}

/**
 * Checks a requested tool against the declaration (D-1). `true` allows only the person's default
 * agent, and a list allows only the tools it names. A request that names no tool resolves to the
 * default tool — if the default is not in the list, it resolves to the list's first tool instead (it
 * never resolves outside the declaration).
 */
export function pickAgentTool(declared: boolean | string[] | undefined, requested: string | undefined, fallback: string): { tool: string } | { error: string } {
  if (declared === true) {
    if (requested !== undefined && requested !== fallback) {
      return {
        error:
          `this app declared "agent": true, which lets it use the person's default agent (${fallback}) only. ` +
          `To ask for ${requested} by name, list it in centralu.app.json: "uses": { "agent": ["${requested}"] }`,
      }
    }
    return { tool: fallback }
  }
  const list = Array.isArray(declared) ? declared : []
  if (list.length === 0) return { error: NOT_DECLARED }
  if (requested !== undefined) {
    return list.includes(requested) ? { tool: requested } : { error: `${requested} is not in this app's "uses.agent" (${list.join(', ')})` }
  }
  return { tool: list.includes(fallback) ? fallback : list[0]! }
}

export class BrokerDesk {
  private host: BrokerHost | null = null
  /**
   * What is currently being asked of the person — one per (app, capability). If two requests from the
   * same app try to use the same capability at the same time, only one question is asked (the second
   * waits on the first's answer). The question is withdrawn once every waiter has left, or once time
   * runs out.
   */
  private asking = new Map<string, { answer: Promise<'allow' | 'deny' | null>; waiters: number; withdraw: AbortController; timedOut: boolean }>()
  /** When the currently running agent started, per app (D-5) — one per app */
  private agentsRunning = new Map<string, number>()
  /** When agents were started within the recent window, per app (D-5) */
  private agentStarts = new Map<string, number[]>()

  constructor(
    private apps: DeskApps,
    private book: CapabilityBook,
    /** The cap on waiting for the person's answer, and the window for counting agents (the runtime's timing — reduced by tests) */
    private timing: () => { questionMs: number; agentRateWindowMs: number },
    /** Where a row is kept per request (D-6) — the same thing as the runtime's run ledger. Nothing is kept if absent */
    private ledger: RunLedger | null = null,
  ) {}

  private questionMs(): number {
    return this.timing().questionMs
  }

  /**
   * The JSON Schema engine used to validate an answer — the same one the MCP server SDK uses to
   * validate a tool's outputSchema (ajv, dialect chosen by `$schema`). This avoids adding a new
   * dependency to the repository.
   */
  private schemas = new AjvJsonSchemaValidator()

  /** The host's core fills in the body (`SessionManager.useExternalApps`). Empties it if null */
  attach(host: BrokerHost | null): void {
    this.host = host
  }

  /**
   * Runs one request all the way through — and **records a row no matter how it ends** (D-6). A
   * denial, a failure, a cancellation, all of them. This is where the person building the requesting
   * app reads "why didn't the agent run" in the runs panel, and where a person reads "what did this
   * app do in my name".
   */
  async handle(app: DeskApp, tool: BrokerToolName, args: Record<string, unknown>, call: BrokerCall): Promise<CallToolResult> {
    const row = new BrokerRow(this.ledger, app.ref, tool, args, call.parentRunId, this.apps.redactor(app.ref))
    if (tool !== 'call_app') row.open()
    try {
      const a =
        tool === 'run_agent' ? await this.runAgent(app, args, call, row) : tool === 'call_app' ? await this.callApp(app, args, call) : await this.hostData(app, args, call)
      if (a.status !== 'delegated') row.close(a.status, a.status === 'ok' ? null : firstText(a.result), a.status === 'error' ? a.result : null)
      return a.result
    } catch (e) {
      row.close(call.signal.aborted ? 'cancelled' : 'error', (e as Error).message)
      throw e
    }
  }

  /**
   * A request the gatekeeper never accepted is also a row (D-6) — either there was no run id, or the
   * presented id was not open for this app. There is no parent: recording the presented id as the
   * parent would let an app nest a row into someone else's chain with a made-up id. The presented id
   * survives only inside the reason text.
   */
  refused(app: DeskApp, tool: BrokerToolName, args: Record<string, unknown>, why: string): void {
    new BrokerRow(this.ledger, app.ref, tool, args, null, this.apps.redactor(app.ref)).close('rejected', why)
  }

  /**
   * `host_data` (D-3) — only a name from the closed list, and only one the manifest listed in
   * `uses.host`. Both default to refusal: a name outside the list is not a capability at all, and one
   * the manifest never listed is a capability it declared it would not use. The answer is one JSON
   * value (the same text as `structuredContent`).
   */
  private async hostData(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall): Promise<Answer> {
    const parsed = HostDataArgs.safeParse(raw)
    if (!parsed.success) return fail(`host_data: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { name } = parsed.data
    if (!isHostCapability(name)) {
      return refuse(`host_data: Centralu has no host capability "${name}" — it can give: ${HOST_CAPABILITIES.join(', ')}`)
    }
    const declared = app.manifest.uses.host ?? []
    if (!declared.includes(name)) {
      return refuse(`host_data refused: "${name}" is not in this app's "uses.host" — declare it in centralu.app.json: "uses": { "host": ["${name}"] }`)
    }
    const host = this.host
    if (!host) return refuse('host_data is unavailable: this Centralu has no host data to give')
    const denied = await this.permit('host_data', app, { kind: 'host', name }, hostCapabilityText(name, app.ref.projectId === null ? 'user' : 'project'), call)
    if (denied) return denied
    const data = await host.hostData(name, app.ref)
    return { status: 'ok', result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } }
  }

  /**
   * `run_agent` (D-1) — checking the declaration, choosing a tool, checking the schema, running it,
   * and validating the answer.
   *
   * **What gets returned is exactly what was validated.** For a request that supplied a schema, the
   * answer is validated once more here against that same schema, even though the tool may have
   * already shaped it (the CLI re-prompts for Claude, and decoding is bound for Codex). The app
   * trusts this answer and writes it into its own state — what it receives is what we verified, not
   * merely what the tool promised.
   */
  private async runAgent(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall, row: BrokerRow): Promise<Answer> {
    const parsed = RunAgentArgs.safeParse(raw)
    if (!parsed.success) return fail(`run_agent: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { prompt, tool: requested, schema } = parsed.data
    if (!prompt.trim()) return fail('run_agent needs a prompt')
    if (prompt.length > AGENT_PROMPT_MAX_CHARS) {
      return fail(`run_agent: the prompt is ${prompt.length} characters, over the ${AGENT_PROMPT_MAX_CHARS} limit — pass large material as a file the agent can read`)
    }
    // The declaration is checked first — an app that never declared this is refused for the same reason no matter what the host could lend it
    const declared = app.manifest.uses.agent
    if (!declared || (Array.isArray(declared) && declared.length === 0)) return refuse(`run_agent refused: ${NOT_DECLARED}`)
    const host = this.host
    if (!host) return refuse('run_agent is unavailable: this Centralu has no agent sessions to lend')
    const picked = pickAgentTool(declared, requested, host.defaultAgentTool(app.ref.projectId))
    if ('error' in picked) return refuse(`run_agent refused: ${picked.error}`)

    let check: ((value: unknown) => string | null) | null = null
    if (schema) {
      const problem = this.schemaProblem(schema)
      if (problem) return fail(`run_agent: ${problem}`)
      const validate = this.schemas.getValidator(schema as never)
      check = (value) => {
        const r = validate(value)
        return r.valid ? null : r.errorMessage
      }
    }

    const denied = await this.permit('run_agent', app, { kind: 'agent', tool: picked.tool }, `run an agent (${host.agentLabel(picked.tool)}) in a new session`, call)
    if (denied) return denied

    // Runaway prevention (D-5) — no awaiting happens between counting and claiming the slot: if two requests from the same app arrive together, only one gets through
    const key = slotOf(app.ref)
    const since = this.agentsRunning.get(key)
    if (since !== undefined) {
      return refuse(
        `run_agent refused: ${app.name} already has an agent running (started ${humanDuration(Date.now() - since)} ago) — ` +
          'Centralu runs one agent per app at a time. Ask again when it has finished.',
      )
    }
    const windowMs = this.timing().agentRateWindowMs
    const now = Date.now()
    const recent = (this.agentStarts.get(key) ?? []).filter((t) => t > now - windowMs)
    if (recent.length >= AGENT_RUNS_PER_WINDOW) {
      return refuse(
        `run_agent refused: ${app.name} started ${recent.length} agents within ${humanDuration(windowMs)}, the most Centralu allows — ` +
          `ask again in ${humanDuration(recent[0]! + windowMs - now)}, or put more of the work into one prompt`,
      )
    }
    this.agentStarts.set(key, [...recent, now])
    this.agentsRunning.set(key, now)
    let r: AgentRunResult
    try {
      r = await host.runAgent(
        { app: app.ref, appName: app.name, tool: picked.tool, prompt, ...(schema ? { schema } : {}) },
        { signal: call.signal, progress: call.progress, onSession: (id) => row.link(id), onUsage: (t) => (row.used = t) },
      )
    } finally {
      this.agentsRunning.delete(key)
    }
    if (!check) return say(r.text)

    const structured = r.output !== undefined ? r.output : parseJsonAnswer(r.text)
    const problem = structured === undefined ? 'the answer is not JSON' : check(structured)
    if (problem) {
      const seen = r.output !== undefined ? JSON.stringify(r.output) : r.text
      return fail(
        `run_agent: the agent's answer does not match the schema (${problem}). ` +
          `The answer was: ${seen.length > 2000 ? `${seen.slice(0, 2000)}…` : seen || '(empty)'}`,
      )
    }
    return { status: 'ok', result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured as Record<string, unknown> } }
  }

  /**
   * `call_app` (D-2) — only the agent-facing (`model`) tools of an app listed in `uses.apps`, under
   * the same scoping rule as a session.
   *
   * The call itself goes through the runtime's one path (caller `app`, parent = the run that
   * triggered this request). So audience checking (a screen-only tool is refused), refusing an
   * untrusted or stopped app, run ids, and the ledger all happen exactly as they would for any other
   * call, and this call is cancelled too if the parent run ends or is cancelled. The called app's
   * answer is returned as-is — if it answered with a failure, it stays a failure.
   */
  private async callApp(app: DeskApp, raw: Record<string, unknown>, call: BrokerCall): Promise<Answer> {
    const parsed = CallAppArgs.safeParse(raw)
    if (!parsed.success) return fail(`call_app: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
    const { app: id, tool, args } = parsed.data
    const listed = app.manifest.uses.apps ?? []
    if (!listed.includes(id)) {
      return refuse(
        `call_app refused: "${id}" is not in this app's "uses.apps"${listed.length ? ` (${listed.join(', ')})` : ''} — ` +
          'an app may call only the apps its manifest lists',
      )
    }
    const target = resolveCallTarget(app.ref, id, (r) => this.apps.has(r))
    if (!target) {
      return fail(
        app.ref.projectId === null
          ? `call_app: there is no app "${id}" in your user folder — an app from the user folder can call only other apps there`
          : `call_app: there is no app "${id}" in this project or in your user folder`,
      )
    }
    // Runaway prevention (D-5) — before asking the person: they are never bothered with a request that would be refused anyway
    const path = this.apps.chain(call.parentRunId)
    const shown = [...path, { ref: target, tool }].map((p) => `${p.ref.appId}.${p.tool}`).join(' → ')
    if (path.some((p) => p.ref.appId === target.appId && p.ref.projectId === target.projectId && p.tool === tool)) {
      return refuse(`call_app refused: ${id}.${tool} is already running in this chain (${shown}) — calling it again would go round in a loop`)
    }
    if (path.length >= CHAIN_DEPTH_MAX) {
      return refuse(
        `call_app refused: this chain would be ${path.length + 1} app calls deep (${shown}) — ` +
          `Centralu stops a chain at ${CHAIN_DEPTH_MAX} so apps cannot call each other without end`,
      )
    }
    const where = target.projectId === null && app.ref.projectId !== null ? ' from your user folder' : ''
    const denied = await this.permit('call_app', app, { kind: 'app', target }, `call the app "${this.apps.name(target)}"${where}`, call)
    if (denied) return denied
    const o = await this.apps.call(target, tool, args ?? {}, { kind: 'app', parentRunId: call.parentRunId }, { signal: call.signal })
    // From here, the record is the called app's own row (`Answer`'s delegated). If the called app answered, its answer is returned as-is (if it was a failure, it stays a failure)
    if (o.result) return { status: 'delegated', result: o.status === 'ok' ? o.result : { ...o.result, isError: true } }
    const how = o.status === 'cancelled' ? 'was cancelled' : o.status === 'rejected' ? 'was refused' : 'failed'
    return { status: 'delegated', result: { content: [{ type: 'text', text: `call_app: ${id}.${tool} ${how} — ${o.error ?? 'no reason was given'}` }], isError: true } }
  }

  /**
   * Capability approval (D-4) — asks the person once, the **first** time a request past the
   * declaration uses that capability. Returns the result to give the app if denied, or null if
   * allowed.
   *
   * The answer is remembered per (app, capability) — an allow and a deny alike. This is the promise
   * that the person is never asked the same thing twice, and an answer pressed by mistake can be
   * forgotten from the runs panel's list (`apps.forgetPermission`). If the manifest's `uses` changes,
   * the fingerprint changes with it and the remembered answer is no longer used — the app's builder
   * has restated what it uses, so the person looks at it again too.
   *
   * The app's call stays alive while this waits (a progress notification over the broker conduit,
   * `broker.ts`). If the person never answers and the cap (5 minutes) passes, this closes as a
   * denial, but **remembers nothing** — that is not an answer. It asks again the next time this is
   * used.
   */
  private async permit(tool: BrokerToolName, app: DeskApp, capability: Capability, text: string, call: BrokerCall): Promise<Answer | null> {
    const key = capabilityKey(capability)
    const stamp = usesStamp(app.manifest.uses)
    const known = this.book.get(app.ref, key)
    const denied = (): Answer => {
      this.apps.denied(call.parentRunId, { app: app.ref, name: app.name, capability: key, text })
      return refuse(deniedText(tool, app.name, text))
    }
    if (known && known.stamp === stamp) return known.decision === 'allow' ? null : denied()
    const host = this.host
    if (!host) return refuse('the broker is unavailable: there is no one to ask for permission')

    const slot = `${app.ref.projectId ?? '_user'}/${app.ref.appId} ${key}`
    let q = this.asking.get(slot)
    if (!q) {
      const withdraw = new AbortController()
      const askedAt = Date.now()
      const expiresAt = askedAt + this.questionMs()
      const entry = {
        answer: host.askCapability(
          { app: app.ref, appName: app.name, capability: key, text, origin: this.apps.origin(call.parentRunId) ?? { kind: 'view', app: app.ref }, askedAt, expiresAt },
          withdraw.signal,
        ),
        waiters: 0,
        withdraw,
        timedOut: false,
      }
      const timer = setTimeout(() => {
        entry.timedOut = true
        withdraw.abort()
      }, expiresAt - Date.now())
      timer.unref?.()
      void entry.answer.finally(() => {
        clearTimeout(timer)
        if (this.asking.get(slot) === entry) this.asking.delete(slot)
      })
      this.asking.set(slot, entry)
      q = entry
    }
    const asked = q
    asked.waiters += 1
    call.progress(`waiting for the person to allow ${app.name} to ${text}`)
    let left = false
    const leave = () => {
      if (left) return
      left = true
      asked.waiters -= 1
      // Every waiter has left — there is no longer a reason to ask
      if (asked.waiters === 0) asked.withdraw.abort()
    }
    call.signal.addEventListener('abort', leave, { once: true })
    let answer: 'allow' | 'deny' | null
    try {
      answer = await Promise.race([
        asked.answer,
        new Promise<null>((resolve) => (call.signal.aborted ? resolve(null) : call.signal.addEventListener('abort', () => resolve(null), { once: true }))),
      ])
    } finally {
      call.signal.removeEventListener('abort', leave)
      leave()
    }
    if (call.signal.aborted) throw new Error('cancelled while waiting for the person')
    if (answer === null) {
      return refuse(
        asked.timedOut
          ? `${tool} refused: the person did not answer within ${humanDuration(this.questionMs())} whether ${app.name} may ${text}. Nothing was remembered — Centralu asks again next time.`
          : `${tool} refused: the question to the person was withdrawn before an answer`,
      )
    }
    // Even if the answer reaches more than one waiter, it only needs to be remembered once — writing the same value again is harmless
    this.book.put(app.ref, { capability: key, text, decision: answer, stamp, decidedAt: Date.now() })
    return answer === 'allow' ? null : denied()
  }

  /**
   * The remembered answers for one app (D-4) — shown and forgettable in the runs panel. `current`
   * means the answer was given against the same fingerprint as the manifest's current declaration; if
   * not, that answer is no longer used (it is asked again).
   */
  permissions(ref: AppRef, manifestUses: unknown | null): (CapabilityDecisionListed)[] {
    const stamp = manifestUses === null ? null : usesStamp(manifestUses)
    return this.book
      .list(ref)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .map((d) => ({ capability: d.capability, text: d.text, decision: d.decision, decidedAt: d.decidedAt, current: d.stamp === stamp }))
  }

  forgetPermission(ref: AppRef, capability: string): void {
    this.book.forget(ref, capability)
  }

  /**
   * Checked before a schema is accepted. Why the root must be an object: the answer goes into an MCP
   * result's `structuredContent`, and that field is an object. Codex's structured output (the OpenAI
   * convention) also requires an object at the root. A schema the engine cannot read is refused
   * **before** starting a session — waiting until a session has started and the tool has already run
   * for a turn to say "the schema is invalid" would only spend the person's usage for nothing.
   */
  private schemaProblem(schema: Record<string, unknown>): string | null {
    const size = JSON.stringify(schema).length
    if (size > AGENT_SCHEMA_MAX_BYTES) return `the schema is ${size} bytes, over the ${AGENT_SCHEMA_MAX_BYTES} limit`
    if (schema.type !== 'object') return 'the schema must describe a JSON object at the top level ("type": "object")'
    try {
      this.schemas.getValidator(schema as never)
    } catch (e) {
      return `the schema is not a JSON Schema this host can read: ${(e as Error).message}`
    }
    return null
  }
}

/**
 * Reads the final text as JSON — for Codex, a schema-bound turn's last message is itself the answer.
 * This also reads it when wrapped in a code fence (```json … ```): a habitual fence from the model
 * must not cause a valid answer to be thrown away. Returns undefined if it cannot be read.
 */
function parseJsonAnswer(text: string): unknown {
  const t = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t)
  try {
    return JSON.parse(fenced ? fenced[1]! : t)
  } catch {
    return undefined
  }
}
