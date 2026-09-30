import type { Socket } from 'node:net'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { CLIENT_INFO } from '@cc/protocol'
import { z } from 'zod'

/**
 * The broker server — the path an app uses to make outbound requests (M4 A-4, from the plan "the
 * path an app uses to make outbound requests", spike S-5).
 *
 * On the fd 3 the host hands the app process, **the host is the MCP server and the app is the
 * client.** Only a process holding the pipe can call it, so there is no token, and the pipe itself
 * tells us who is calling (a pipe is born tied to exactly one app). What the call is for is carried
 * by the **run id**: when the host sends a tool call to the app, it attaches it in
 * `_meta["centralu/runId"]`, and the app attaches that same id when it calls the broker while
 * handling that call (the template's helper hides this — S-5's AsyncLocalStorage).
 *
 * There is exactly one condition for admission: **a run id that is currently open for this pipe's
 * app.** If there is none (the app woke itself up on its own — out of scope for v1), it is refused,
 * and so is someone else's id or a made-up one.
 *
 * This file is **only the gatekeeper and the conduit.** What an admitted request is actually resolved
 * into (declarations, capability approval, runaway prevention, the ledger, and the body of each
 * tool) is decided by the runtime's desk (`desk.ts`) — handed off through a single `BrokerHandler`.
 */

/** The `_meta` key the run id is carried in. Both the host→app call and the app→broker call use the same key */
export const RUN_META = 'centralu/runId'

export const BROKER_TOOLS = ['run_agent', 'call_app', 'host_data'] as const
export type BrokerToolName = (typeof BROKER_TOOLS)[number]

/**
 * The interval between progress notifications sent to a waiting broker call.
 *
 * An app's client does not wait forever for one request's answer — the MCP SDK's default cap is 60
 * seconds, and the template's helper also gives up after 60 seconds of silence
 * (`app-runtime/src/broker.mjs`). An agent run takes longer than that (measured: 4.0 seconds for a
 * one-sentence answer from haiku, 5.6 seconds for an answer given a schema — and work that uses
 * tools takes minutes), and capability approval waits on the person for up to 5 minutes (D-4). At
 * once every 10 seconds, that reaches six notifications within the 60-second cap — a few late ones
 * still do not break the connection.
 */
export const BROKER_KEEPALIVE_MS = 10_000

/** The run that triggered a broker call — used by the desk to stitch the chain together */
export type BrokerCall = {
  /** The run id of the host→app call that triggered this broker call */
  parentRunId: string
  /** Set when the app cancels it, or when the parent run ends or is cancelled */
  signal: AbortSignal
  /**
   * Sends a one-line status to the waiting app (a progress notification) — only reaches it if the
   * app attached a progress token. The keepalive notification is already sent by this conduit itself
   * (`BROKER_KEEPALIVE_MS`), so the handler only needs to call this when it has something to say,
   * like "waiting on the person's answer".
   */
  progress(message: string): void
}

/** The one desk that resolves an admitted broker call — every tool comes through this single point */
export type BrokerHandler = (tool: BrokerToolName, args: Record<string, unknown>, call: BrokerCall) => Promise<CallToolResult>

/** What one pipe's gatekeeper asks — "is this id currently open for this app" */
export type BrokerAdmission = {
  /** The cancellation signal for that run if it is open, otherwise null */
  openRun(runId: string): AbortSignal | null
  /** Records a denial in that app's own log — where the building agent reads why it was blocked */
  note(line: string): void
  /** Also records a request that was never admitted, in the run ledger (D-6) — a denial is a row too. This is where a person reads it, in the app's runs panel */
  refused(tool: BrokerToolName, args: Record<string, unknown>, why: string): void
}

const schemas: Record<BrokerToolName, { description: string; input: z.ZodObject<z.ZodRawShape> }> = {
  run_agent: {
    description:
      'Ask the agent of the person using this app, and get its final answer. Each request runs in a new session under this app. With schema (a JSON Schema whose top level is an object) the answer comes as JSON of that shape in structuredContent',
    input: z.object({
      prompt: z.string(),
      /** A tool name the manifest's `uses.agent` allows. If absent, the person's default agent */
      tool: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  call_app: {
    description: "Call a tool of another app that this app's manifest lists in uses.apps (its tools open to agents only)",
    input: z.object({ app: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
  host_data: {
    description:
      "Read Centralu's own data by name — a closed list (sessions.list, git.status), only the names this app declares in uses.host. All of it is read-only",
    // The name is not restricted to an enum here — for an unrecognized name, the desk states what it can give instead of an SDK input error
    input: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/**
 * Opens the broker server on fd 3. Closed with the function it returns.
 *
 * The host side uses the SDK's transport unmodified (S-5: zero additional code) — `serveStdio`
 * handles both spec generations.
 */
export function serveBroker(
  fd3: Socket,
  admission: BrokerAdmission,
  handle: BrokerHandler,
  opts: { keepaliveMs?: number } = {},
): () => void {
  const keepaliveMs = opts.keepaliveMs ?? BROKER_KEEPALIVE_MS
  const serve = serveStdio(
    () => {
      const server = new McpServer({ name: `${CLIENT_INFO.name}-broker`, version: CLIENT_INFO.version }, { capabilities: { tools: {} } })
      for (const tool of BROKER_TOOLS) {
        server.registerTool(tool, { description: schemas[tool].description, inputSchema: schemas[tool].input }, async (args, ctx) => {
          const presented = ctx.mcpReq._meta?.[RUN_META]
          if (typeof presented !== 'string' || presented.length === 0) {
            const why = 'rejected: a broker call must carry the run id of the call being handled (an app waking up by itself is out of scope)'
            admission.note(`broker rejected ${tool}: no run id`)
            admission.refused(tool, args as Record<string, unknown>, why)
            return text(why, true)
          }
          const runSignal = admission.openRun(presented)
          if (!runSignal) {
            // The presented id could be text the app made up — carry it in the reason, but truncate it
            const shown = presented.length > 80 ? `${presented.slice(0, 80)}…` : presented
            const why = `rejected: ${shown} is not an open run of this app`
            admission.note(`broker rejected ${tool}: ${shown} is not an open run of this app`)
            admission.refused(tool, args as Record<string, unknown>, why)
            return text(why, true)
          }
          /*
           * Cancellation arrives by two paths: the app cancels its own broker call
           * (notifications/cancelled → ctx.mcpReq.signal), or something further up cancels the
           * parent run. These two are combined so the downstream work never outlives its parent, even
           * for an app that never forwards a cancellation signal of its own.
           */
          const signal = AbortSignal.any([ctx.mcpReq.signal, runSignal])
          /*
           * Keeps the app alive while it waits — only if the app attached a progress token (per the
           * spec: no token means never sending a progress notification). The value rises with each
           * send (per the spec: progress must increase). Stops once it ends — a notification arriving
           * after the reply would carry a token the receiver no longer recognizes.
           */
          const token = ctx.mcpReq._meta?.progressToken
          let beat = 0
          const progress = (message?: string) => {
            if (token === undefined || signal.aborted) return
            beat += 1
            void ctx.mcpReq
              .notify({ method: 'notifications/progress', params: { progressToken: token, progress: beat, ...(message ? { message } : {}) } })
              .catch(() => {})
          }
          const timer = token === undefined ? null : setInterval(() => progress(), keepaliveMs)
          timer?.unref()
          try {
            return await handle(tool, args as Record<string, unknown>, { parentRunId: presented, signal, progress })
          } catch (e) {
            if (signal.aborted) return text(`cancelled: ${tool} under ${presented}`, true)
            return text(`${tool} failed: ${(e as Error).message}`, true)
          } finally {
            if (timer) clearInterval(timer)
          }
        })
      }
      return server
    },
    { transport: new StdioServerTransport(fd3, fd3), onerror: (e) => admission.note(`broker error: ${e.message}`) },
  )
  return () => void serve.close().catch(() => {})
}
