/* eslint-disable @typescript-eslint/no-explicit-any -- the recorder reads the API's raw JSON */
/**
 * The Messages API as Claude Code sees it, recorded (#513).
 *
 * The host's Claude sessions are started with `ANTHROPIC_BASE_URL` pointing here, so every request the
 * CLI makes passes through one local server. Two modes:
 *
 *   forward  passes each request on to api.anthropic.com unchanged and streams the answer back,
 *            reading the usage the API itself reports (input, cache read, cache write, output)
 *   fake     answers without any model: a scripted reply (text, or a tool call the driver queued),
 *            so the real CLI builds its real requests and nothing is spent
 *
 * In both, each request's tool list, system prompt and messages are fingerprinted, and compared with
 * the session's previous request: what the prompt cache can reuse is the part of a request that is
 * byte-identical to the one before, and the tool list comes first.
 *
 * Nothing about the request's credentials is kept: headers are passed through (forward) or dropped
 * (fake), never written down.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number }

export type ToolUse = { id: string; name: string; input: unknown }

/** One part of a request against the same session's previous request */
export type PartChange = 'first' | 'same' | 'changed'

export type RecordedRequest = {
  seq: number
  /** The CLI's own conversation id (`metadata.user_id.session_id`) */
  cliSession: string | null
  /** The driver's name for the session it was driving: requests are compared within one, across restarts */
  session: string
  /** What the driver had just done when this request went out (`event`), or what this request follows within a turn */
  event: string
  step: string
  model: string
  /** A request with a tool list: the conversation itself. A request with none is the CLI's own errand (a title) */
  main: boolean
  toolsHash: string
  systemHash: string
  toolsChars: number
  systemChars: number
  /** Tools in the request's tool list, loaded (not `defer_loading`) */
  loadedTools: string[]
  /** Centralu's and attached apps' tools among them, and their characters */
  centraluLoaded: string[]
  centraluChars: number
  appLoaded: string[]
  /** Names Claude Code announced as deferred in this request's messages, every announcement so far */
  deferredNames: string[]
  messages: number
  /**
   * Against the previous main request of the same session. `tools` is the loaded tool list; a tool
   * the model loaded through tool search joins the list as a `defer_loading` entry, counted apart
   * (`deferredEntries`), since the API keeps those out of the cached prefix and a live run is what
   * says whether that holds.
   */
  tools: PartChange
  deferredEntries: PartChange
  deferredEntryNames: string[]
  system: PartChange
  /** `extends` when the previous request's messages are all still there unchanged; otherwise the first index that differs */
  history: 'first' | 'extends' | { rewrittenAt: number }
  /** Characters of tool results in this request's messages, per tool (Centralu's and apps' only) */
  resultChars: Record<string, number>
  usage: Usage | null
  /**
   * Forward mode, a session's first request: what Centralu adds to it, from the API's own token
   * counter. The same request is counted twice (`count_tokens`, which costs nothing): as sent, and
   * with every trace of Centralu's and apps' tools taken out (their definitions, their names in the
   * deferred list, the server's instructions). The difference is theirs alone, which a comparison of
   * two sessions cannot give: a directing seat also runs on another system prompt.
   */
  counted: { sent: number; withoutOurs: number } | null
  /** The model's tool calls in this request's answer */
  toolUses: ToolUse[]
  status: number
}

type Scripted = { kind: 'text'; text: string } | { kind: 'tool'; name: string; input: Record<string, unknown> }

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12)

/** Messages without cache markers: Claude Code moves `cache_control` to the newest message each request */
function plainMessages(messages: unknown[]): string[] {
  return messages.map((m) => JSON.stringify(m, (k, v) => (k === 'cache_control' ? undefined : v)))
}

/** The billing line Claude Code puts first in the system prompt changes per request and is not part of the cached prompt */
function cachedSystem(system: unknown): unknown {
  if (!Array.isArray(system)) return system
  return system.filter((b) => !(typeof b?.text === 'string' && b.text.startsWith('x-anthropic-billing-header')))
}

const DEFERRED_HEAD = 'The following deferred tools are now available via ToolSearch'

function deferredNames(messages: unknown[]): string[] {
  const names: string[] = []
  for (const m of messages as { content?: unknown }[]) {
    const blocks = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : []
    for (const b of blocks) {
      if (b.type !== 'text' || !b.text?.includes(DEFERRED_HEAD)) continue
      const body = b.text.slice(b.text.indexOf(DEFERRED_HEAD))
      for (const l of body.split('\n').slice(1).map((x) => x.trim())) if (/^[\w.-]+$/.test(l) && !names.includes(l)) names.push(l)
    }
  }
  return names
}

const ours = (name: string) => name.startsWith('mcp__centralu__') || name.startsWith('mcp__app-')

const INSTRUCTIONS_HEAD = '# MCP Server Instructions'

/** A text block with Centralu's traces taken out, or null when nothing of it is left but its frame */
function stripText(text: string): string | null {
  let t = text
  if (t.includes(DEFERRED_HEAD)) t = t.split('\n').filter((l) => !ours(l.trim())).join('\n')
  if (t.includes(INSTRUCTIONS_HEAD)) {
    t = t.replace(/\n## centralu\n[\s\S]*?(?=\n## |\n<\/system-reminder>|$)/, '')
    if (!/\n## /.test(t)) return null
  }
  return t
}

/** The request as it would be without Centralu's tools, for counting */
export function withoutOurs(j: Record<string, any>): Record<string, any> {
  const messages = (j.messages as Record<string, any>[]).map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: (m.content as Record<string, any>[]).flatMap((b) => {
            if (b.type !== 'text' || typeof b.text !== 'string') return [b]
            const t = stripText(b.text)
            return t === null ? [] : [{ ...b, text: t }]
          }),
        }
      : m,
  )
  return { ...j, tools: (j.tools as Record<string, any>[]).filter((t) => !ours(String(t.name))), messages }
}

function resultChars(messages: unknown[]): Record<string, number> {
  const names = new Map<string, string>()
  const out: Record<string, number> = {}
  for (const m of messages as { content?: unknown }[]) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as Record<string, unknown>[]) {
      if (b.type === 'tool_use') names.set(String(b.id), String(b.name))
      if (b.type === 'tool_result') {
        const name = names.get(String(b.tool_use_id)) ?? '?'
        if (!ours(name)) continue
        out[name] = (out[name] ?? 0) + JSON.stringify(b.content ?? '').length
      }
    }
  }
  return out
}

/** Reads a streamed answer: its usage, and the tool calls in it */
function readStream(text: string): { usage: Usage | null; toolUses: ToolUse[] } {
  let usage: Usage | null = null
  const toolUses: ToolUse[] = []
  const open = new Map<number, { id: string; name: string; json: string }>()
  for (const chunk of text.split('\n\n')) {
    const line = chunk.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    let e: Record<string, any>
    try {
      e = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    if (e.type === 'message_start') {
      const u = e.message?.usage ?? {}
      usage = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    } else if (e.type === 'message_delta' && usage) {
      if (typeof e.usage?.output_tokens === 'number') usage.output = e.usage.output_tokens
    } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      open.set(e.index, { id: String(e.content_block.id ?? ''), name: e.content_block.name, json: '' })
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
      const o = open.get(e.index)
      if (o) o.json += e.delta.partial_json ?? ''
    } else if (e.type === 'content_block_stop' && open.has(e.index)) {
      const o = open.get(e.index)!
      open.delete(e.index)
      let input: unknown = {}
      try {
        input = o.json ? JSON.parse(o.json) : {}
      } catch {
        input = o.json
      }
      toolUses.push({ id: o.id, name: o.name, input })
    }
  }
  return { usage, toolUses }
}

function sse(model: string, reply: Scripted, n: number): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let out = ev('message_start', {
    message: { id: `msg_fake_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  })
  if (reply.kind === 'text') {
    out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } })
  } else {
    out += ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${n}`, name: reply.name, input: {} } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } })
  }
  out += ev('content_block_stop', { index: 0 })
  out += ev('message_delta', { delta: { stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  out += ev('message_stop', {})
  return out
}

export class ApiRecorder {
  readonly requests: RecordedRequest[] = []
  private server: Server | null = null
  private script: Scripted[] = []
  private event = 'first'
  private step = ''
  private key = ''
  /** Whether the driver's event was already given to a request: the ones after it in the same turn follow a tool */
  private eventTaken = false
  private last = new Map<string, { tools: string; deferred: string; system: string; messages: string[] }>()
  private lastTool = new Map<string, string>()
  private n = 0
  private counting: Promise<void>[] = []
  port = 0

  constructor(private mode: 'forward' | 'fake') {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => void this.handle(req, Buffer.concat(chunks), res))
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.port = (this.server.address() as { port: number }).port
    return this.port
  }

  /** Waits for the token counts still out */
  async settle(): Promise<void> {
    await Promise.allSettled(this.counting)
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }

  /** What the next requests follow, until the driver says otherwise */
  mark(session: string, step: string, event: string): void {
    this.key = session
    this.step = step
    this.event = event
    this.eventTaken = false
  }

  /** The fake model's next answers, in order, replacing any left over (fake mode). With none queued it answers "OK." */
  queue(...replies: Scripted[]): void {
    this.script = [...replies]
  }

  private async handle(req: IncomingMessage, body: Buffer, res: import('node:http').ServerResponse): Promise<void> {
    let j: Record<string, any> | null = null
    try {
      j = JSON.parse(body.toString('utf8'))
    } catch {
      j = null
    }
    const isMessages = req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages') && !(req.url ?? '').includes('count_tokens') && j
    if (!isMessages) {
      if (this.mode === 'forward') return this.forward(req, body, res, null)
      res.writeHead(req.method === 'HEAD' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(req.method === 'HEAD' ? undefined : '{"type":"error","error":{"type":"not_found_error","message":"not served by the recorder"}}')
      return
    }
    const rec = this.describe(j!)
    this.requests.push(rec)
    if (this.mode === 'forward') {
      if (rec.main && rec.history === 'first') this.counting.push(this.count(j!, req, rec))
      return this.forward(req, body, res, rec)
    }
    const reply: Scripted = rec.main ? (this.script.shift() ?? { kind: 'text', text: 'OK.' }) : { kind: 'text', text: 'Measurement' }
    rec.toolUses = reply.kind === 'tool' ? [{ id: `toolu_fake_${rec.seq}`, name: reply.name, input: reply.input }] : []
    rec.status = 200
    this.noteTool(rec)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(sse(String(j!.model ?? 'fake'), reply, rec.seq))
  }

  private forward(req: IncomingMessage, body: Buffer, res: import('node:http').ServerResponse, rec: RecordedRequest | null): void {
    const headers = { ...req.headers, host: 'api.anthropic.com' }
    // Plain text back, so the stream can be read on its way through
    delete headers['accept-encoding']
    const up = httpsRequest({ host: 'api.anthropic.com', path: req.url, method: req.method, headers }, (u) => {
      res.writeHead(u.statusCode ?? 502, u.headers)
      let text = ''
      u.on('data', (c: Buffer) => {
        if (rec) text += c.toString('utf8')
        res.write(c)
      })
      u.on('end', () => {
        res.end()
        if (!rec) return
        rec.status = u.statusCode ?? 0
        const read = readStream(text)
        rec.usage = read.usage
        rec.toolUses = read.toolUses
        this.noteTool(rec)
      })
    })
    up.on('error', (e) => {
      if (rec) rec.status = -1
      res.writeHead(502)
      res.end(String(e))
    })
    up.end(body)
  }

  private async count(j: Record<string, any>, req: IncomingMessage, rec: RecordedRequest): Promise<void> {
    const one = (body: Record<string, any>) =>
      new Promise<number | null>((resolve) => {
        const payload = Buffer.from(JSON.stringify({ model: body.model, system: body.system, tools: body.tools, messages: body.messages }))
        const headers: Record<string, unknown> = { ...req.headers, host: 'api.anthropic.com', 'content-length': payload.length }
        delete headers['accept-encoding']
        const r = httpsRequest({ host: 'api.anthropic.com', path: '/v1/messages/count_tokens?beta=true', method: 'POST', headers: headers as never }, (u) => {
          let text = ''
          u.on('data', (c: Buffer) => (text += c.toString('utf8')))
          u.on('end', () => {
            try {
              const n = JSON.parse(text).input_tokens
              resolve(typeof n === 'number' ? n : null)
            } catch {
              resolve(null)
            }
          })
        })
        r.on('error', () => resolve(null))
        r.end(payload)
      })
    const [sent, without] = await Promise.all([one(j), one(withoutOurs(j))])
    rec.counted = sent !== null && without !== null ? { sent, withoutOurs: without } : null
  }

  private noteTool(rec: RecordedRequest): void {
    if (rec.main) {
      const t = rec.toolUses.at(-1)
      if (t) this.lastTool.set(rec.session, t.name)
      else this.lastTool.delete(rec.session)
    }
  }

  private describe(j: Record<string, any>): RecordedRequest {
    const tools = (Array.isArray(j.tools) ? j.tools : []) as Record<string, any>[]
    const messages = (Array.isArray(j.messages) ? j.messages : []) as unknown[]
    let cliSession: string | null = null
    try {
      cliSession = JSON.parse(j.metadata?.user_id ?? '{}').session_id ?? null
    } catch {
      cliSession = null
    }
    const main = tools.length > 0
    const loaded = tools.filter((t) => !t.defer_loading)
    const centralu = loaded.filter((t) => String(t.name).startsWith('mcp__centralu__'))
    const toolsKey = JSON.stringify(loaded)
    const deferredEntries = tools.filter((t) => t.defer_loading)
    const deferredKey = JSON.stringify(deferredEntries)
    const systemKey = JSON.stringify(cachedSystem(j.system))
    const plain = plainMessages(messages)
    const prev = main ? this.last.get(this.key) : undefined
    let history: RecordedRequest['history'] = 'first'
    if (prev) {
      const at = prev.messages.findIndex((m, i) => plain[i] !== m)
      history = at === -1 ? 'extends' : { rewrittenAt: at }
    }
    let event: string
    if (!main) event = 'side request'
    else if (!this.eventTaken) {
      event = this.event
      this.eventTaken = true
    } else {
      const after = this.lastTool.get(this.key)
      event = after ? `same turn, after ${after}` : 'same turn'
    }
    const rec: RecordedRequest = {
      seq: ++this.n,
      cliSession,
      session: this.key,
      event,
      step: this.step,
      model: String(j.model ?? ''),
      main,
      toolsHash: hash(toolsKey),
      systemHash: hash(systemKey),
      toolsChars: JSON.stringify(tools).length,
      systemChars: systemKey.length,
      loadedTools: loaded.map((t) => String(t.name)),
      centraluLoaded: centralu.map((t) => String(t.name)),
      centraluChars: centralu.reduce((n, t) => n + JSON.stringify(t).length, 0),
      appLoaded: loaded.filter((t) => String(t.name).startsWith('mcp__app-')).map((t) => String(t.name)),
      deferredNames: deferredNames(messages),
      messages: messages.length,
      tools: prev ? (prev.tools === toolsKey ? 'same' : 'changed') : 'first',
      deferredEntries: prev ? (prev.deferred === deferredKey ? 'same' : 'changed') : 'first',
      deferredEntryNames: deferredEntries.map((t) => String(t.name)),
      system: prev ? (prev.system === systemKey ? 'same' : 'changed') : 'first',
      history,
      resultChars: resultChars(messages),
      usage: null,
      counted: null,
      toolUses: [],
      status: 0,
    }
    if (main) this.last.set(this.key, { tools: toolsKey, deferred: deferredKey, system: systemKey, messages: plain })
    return rec
  }
}

export const say = (text: string): Scripted => ({ kind: 'text', text })
export const call = (name: string, input: Record<string, unknown> = {}): Scripted => ({ kind: 'tool', name, input })
