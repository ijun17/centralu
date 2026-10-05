/**
 * The app used by the external app runtime tests (M4 A). A real MCP server started as a real child
 * process — it imports the v2 server SDK straight from the workspace (the same shape as spike S-5's
 * app-node).
 *
 *   node app.mjs --log <jsonl> [--mode <mode>]
 *
 * --log   writes what this process saw, one JSON object per line. Tests count "how many times it
 *         started", "which methods arrived", and "what environment it received" from this file —
 *         judging by what the app actually experienced, not by anything the host says.
 * --mode  normal | crash-on-start | ignore-eof | grandchild | stubborn-grandchild | detached-grandchild | hold-fd3 | flood-stderr
 *         | secret-to-stderr | bad-tool-name | mediation | view | attach
 *
 * `attach` is the bundle for A-5 (attaching to a session): tools with different annotations (the
 * read-only `peek`, the mutating `poke`), a screen-only tool, `hold`, which holds open until a gate
 * (a `--gate <file>`) appears, and tools added at startup from the names listed in
 * `--extra-from <file>` (for an app whose tool list changes).
 *
 * `mediation` opens the tool bundle for A-4: tools with different audiences, a tool that returns the
 * run id it received, a tool that waits for cancellation, tools that fail or die, and a tool that
 * calls the broker on fd 3. The broker client follows the template helper's own shape exactly (S-5):
 * it unrefs the fd 3 socket, and attaches the received run id back onto its own calls.
 *
 * `view` tests the shape a screen (B-3) receives: an app that keeps state in the server (a single
 * interval), a result's `structuredContent`, `isError`, and `_meta`, and a `ui://` document that
 * declares a CSP. The candidates for a fixed screen's (B-2) home also live here (`home`, `no_screen`,
 * `agent_home`, `bad_home`, `failing_home`).
 *
 * `inline` is the bundle for an in-conversation screen (B-1): an agent-facing tool that declares its
 * own screen (`ui://<app id>/main`) (`show`, `show_big` which chooses the size of its result, and
 * `hold_view` which holds open until the gate appears), a screen-less tool (`plain`), and tools that
 * impersonate someone else's screen (`spoof` in its declaration, `spoof_result` in its result — both
 * point at `ui://other/main`).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const LOG = arg('log')
const MODE = arg('mode') ?? 'normal'
const log = (rec) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...rec })}\n`)
}

const ENV_SEEN = ['CENTRALU_APP_ID', 'CENTRALU_APP_DATA', 'CC_HOST_TOKEN', 'CC_DATA_DIR', 'FIXTURE_SECRET', 'UNDECLARED_SECRET']
log({ t: 'start', mode: MODE, cwd: process.cwd(), env: Object.fromEntries(ENV_SEEN.map((k) => [k, process.env[k] ?? null])) })

if (MODE === 'crash-on-start') {
  process.stderr.write('fixture: cannot open the thing it needs\n')
  process.exit(3)
}
if (MODE === 'flood-stderr') {
  for (let i = 0; i < 400; i++) process.stderr.write(`flood line ${i} ${'x'.repeat(80)}\n`)
}
if (MODE === 'secret-to-stderr') {
  process.stderr.write(`about to use token=${process.env.FIXTURE_SECRET}\n`)
}
if (MODE === 'ignore-eof') {
  // This timer keeps the process alive even after stdin closes — this tests the shutdown rule's "end the tree after the grace period"
  setInterval(() => {}, 1000)
}
if (MODE === 'hold-fd3') {
  // fd 3 without unref — exactly the shape that kept a Node app from ending in S-5. Only once the
  // host closes fd 3 ('end') do we close ours, and only then can the process end
  const sock = new net.Socket({ fd: 3, readable: true, writable: true })
  sock.on('end', () => sock.end())
  sock.on('error', () => {})
}
if (MODE === 'stubborn-grandchild') {
  /*
   * A grandchild that ignores SIGTERM — the app itself ends cleanly once its input closes, but this
   * grandchild holds on against the SIGTERM the group receives. Recorded only **after** attaching its
   * handler: measured, a grandchild still starting (state R in ps) received SIGTERM and died before it
   * ever attached the handler.
   */
  const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  kid.stdout.once('data', () => {
    log({ t: 'grandchild', grandchild: kid.pid })
    kid.stdout.destroy()
    kid.unref()
  })
}
if (MODE === 'detached-grandchild') {
  /*
   * A grandchild started outside the app's own job, the way any non-Node app (Python, a shell) starts its children on
   * Windows. Node puts a child spawned without `detached` into a job that ends it together with this process; this one
   * is not in it, so on Windows it outlives the app unless the host collects it (#14).
   */
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true })
  kid.unref()
  log({ t: 'grandchild', grandchild: kid.pid })
}
if (MODE === 'ignore-eof' || MODE === 'grandchild') {
  // A grandchild in the same group — left orphaned unless the host ends the whole tree
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  // So the grandchild's handle never keeps this process alive — 'grandchild' is an app that ends cleanly on its own but leaves a grandchild behind
  kid.unref()
  log({ t: 'grandchild', grandchild: kid.pid })
}

// Records the method of every incoming request — the test checks whether generation probing
// (`server/discover`) arrived. Attached on the same tick as the SDK's own listener, so nothing the
// SDK sees is missed here
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\n')) {
    try {
      const m = JSON.parse(line)
      if (m.method) log({ t: 'method', method: m.method })
    } catch {
      // A fragmented line — this is only a tap used for counting, so it is discarded
    }
  }
})

const RUN_META = 'centralu/runId'
let brokerP
/** The broker client on fd 3 — connects the first time it is called */
function broker() {
  brokerP ??= (async () => {
    const sock = new net.Socket({ fd: 3, readable: true, writable: true })
    // fd 3 alone must never keep the app alive — stdin's EOF is what means "end" (S-5)
    sock.unref()
    const c = new Client({ name: 'fixture-app', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await c.connect(new StdioServerTransport(sock, sock))
    return c
  })()
  return brokerP
}
const say = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

serveStdio(() => {
  const server = new McpServer({ name: 'fixture-app', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } })
  server.registerTool('echo', { description: 'Echo', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }))
  if (MODE === 'mediation') {
    const vis = (visibility) => ({ _meta: { ui: { visibility } } })
    server.registerTool('model_only', { description: 'Only for agents', ...vis(['model']) }, async () => say('model_only ran'))
    server.registerTool('app_only', { description: 'Only for views', ...vis(['app']) }, async () => say('app_only ran'))
    server.registerTool('bad_visibility', { description: 'Malformed visibility', _meta: { ui: { visibility: 'app' } } }, async () => say('should never run'))
    // In v2, a tool with no input schema has a handler that receives only ctx
    server.registerTool('whoami', { description: 'Returns the run id this call carried' }, async (ctx) =>
      say(String(ctx.mcpReq._meta?.[RUN_META] ?? '')),
    )
    server.registerTool('fail', { description: 'Reports a failure' }, async () => say('the thing failed', true))
    server.registerTool('crash', { description: 'Dies in the middle of a call' }, async () => {
      process.stderr.write('fixture: dying mid-call\n')
      process.exit(7)
    })
    server.registerTool('slow', { description: 'Waits until cancelled (or 5s)' }, async (ctx) => {
      const signal = ctx.mcpReq.signal
      const aborted = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 5000)
        signal.addEventListener('abort', () => (clearTimeout(t), resolve(true)), { once: true })
      })
      log({ t: aborted ? 'aborted' : 'finished', runId: ctx.mcpReq._meta?.[RUN_META] ?? null })
      return say(aborted ? 'aborted' : 'finished')
    })
    /*
     * A tool that calls the broker. If `args` is given, it is carried as-is (otherwise each tool has
     * its own fixed arguments); if `timeoutMs` is given, a progress notification resets that cap
     * (`resetTimeoutOnProgress`) — this checks whether the host keeps a waiting request alive. The
     * result carries one line of text plus the broker's answer verbatim in `structuredContent`
     * (isError, text, structured).
     */
    const askBroker = (name, config) => server.registerTool(
      name,
      {
        ...config,
        inputSchema: z.object({
          mode: z.enum(['run', 'run-nosignal', 'run-detached', 'none', 'given']),
          runId: z.string().optional(),
          tool: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
          timeoutMs: z.number().optional(),
          // Relays the broker's progress message up onto this call — what the template's helper (`centralu.agent`) does
          relay: z.boolean().optional(),
        }),
      },
      async ({ mode, runId, tool, args: given, timeoutMs, relay }, ctx) => {
        const own = ctx.mcpReq._meta?.[RUN_META]
        const meta = mode === 'none' ? {} : { [RUN_META]: mode === 'given' ? runId : own }
        const c = await broker()
        const name = tool ?? 'run_agent'
        if (mode === 'run-detached') {
          // Waits only long enough for the request to reach the broker, then answers without waiting
          // for the result — an app whose requested work tries to outlive the run that requested it
          void c.callTool({ name, arguments: given ?? { prompt: 'fire and forget' }, _meta: meta }).catch(() => {})
          await new Promise((r) => setTimeout(r, 150))
          return say('detached')
        }
        const args = given ?? { run_agent: { prompt: 'summarize this' }, call_app: { app: 'other', tool: 'echo' }, host_data: { name: 'sessions.list' } }[name]
        const upToken = ctx.mcpReq._meta?.progressToken
        let beats = 0
        const up = (p) => {
          if (!relay || upToken === undefined || !p.message) return
          void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: upToken, progress: ++beats, message: p.message } }).catch(() => {})
        }
        const r = await c.callTool(
          { name, arguments: args, _meta: meta },
          {
            ...(mode === 'run' ? { signal: ctx.mcpReq.signal } : {}),
            ...(timeoutMs
              ? { timeout: timeoutMs, resetTimeoutOnProgress: true, onprogress: (p) => (log({ t: 'broker-progress', message: p.message ?? null }), up(p)) }
              : relay
                ? { onprogress: up }
                : {}),
          },
        )
        const text = r.content?.map((x) => x.text).join(' ') ?? ''
        log({ t: 'broker-answer', mode, text, isError: !!r.isError })
        return {
          content: [{ type: 'text', text: `broker isError=${!!r.isError}: ${text}` }],
          structuredContent: { isError: !!r.isError, text, structured: r.structuredContent ?? null },
        }
      },
    )
    askBroker('ask_broker', { description: 'Calls the host broker on fd 3' })
    // A read-only tool that does the same thing — even a read-only tool can request an agent and start a chain (the runs panel's signal, M4 D-6)
    askBroker('ask_broker_read', { description: 'Calls the host broker on fd 3, and changes nothing itself', annotations: { readOnlyHint: true } })
    server.registerResource('view', 'ui://fixture/view', { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: '<p>fixture view</p>' }],
    }))
  }
  if (MODE === 'view') {
    let interval = 5
    const state = () => ({
      content: [{ type: 'text', text: `interval ${interval}` }],
      structuredContent: { interval },
      _meta: { 'fixture/served-by': process.pid },
    })
    server.registerTool('get_interval', { description: 'Reads the interval' }, async () => state())
    server.registerTool(
      'set_interval',
      { description: 'Sets the interval', inputSchema: z.object({ seconds: z.number() }) },
      async ({ seconds }) => {
        if (seconds <= 0) {
          return { content: [{ type: 'text', text: 'seconds must be positive' }], structuredContent: { field: 'seconds', got: seconds }, isError: true }
        }
        interval = seconds
        return state()
      },
    )
    server.registerTool('agent_only', { description: 'Only for agents', _meta: { ui: { visibility: ['model'] } } }, async () => say('agent_only ran'))
    // Candidates for the fixed screen's (B-2) home: a tool that declares a screen, one with no screen,
    // a screen tool open only to agents, and one that points somewhere that is not ui://. `home`
    // records every call — the test checks whether the host really called it
    server.registerTool('home', { description: 'Opens the slider', _meta: { ui: { resourceUri: 'ui://fixture/main' } } }, async (ctx) => {
      log({ t: 'home', runId: ctx.mcpReq._meta?.[RUN_META] ?? null })
      return state()
    })
    server.registerTool('no_screen', { description: 'A tool with no view' }, async () => state())
    server.registerTool(
      'agent_home',
      { description: 'A view only agents may open', _meta: { ui: { resourceUri: 'ui://fixture/main', visibility: ['model'] } } },
      async () => state(),
    )
    server.registerTool('bad_home', { description: 'Points its view outside ui://', _meta: { ui: { resourceUri: 'https://evil.test/view' } } }, async () => state())
    server.registerTool('failing_home', { description: 'Answers with a failure', _meta: { ui: { resourceUri: 'ui://fixture/main' } } }, async () =>
      say('the slider is not ready', true),
    )
    server.registerResource('main', 'ui://fixture/main', { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/html;profile=mcp-app',
          text: `<!doctype html><p id="served">view from app process ${process.pid}</p>`,
          _meta: { ui: { csp: { connectDomains: ['https://api.fixture.test'] } } },
        },
      ],
    }))
  }
  if (MODE === 'attach') {
    server.registerTool(
      'peek',
      { title: 'Peek', description: 'Reads the value without changing anything', annotations: { readOnlyHint: true, openWorldHint: false } },
      async () => say('peeked'),
    )
    server.registerTool(
      'poke',
      { description: 'Changes the value', inputSchema: z.object({ to: z.number().describe('the new value') }), annotations: { destructiveHint: false } },
      async ({ to }) => say(`poked ${to}`),
    )
    server.registerTool('app_only', { description: 'Only for views', _meta: { ui: { visibility: ['app'] } } }, async () => say('app_only ran'))
    server.registerTool('hold', { description: 'Holds until the gate file exists or the call is cancelled' }, async (ctx) => {
      const gate = arg('gate')
      const signal = ctx.mcpReq.signal
      const runId = ctx.mcpReq._meta?.[RUN_META] ?? null
      log({ t: 'holding', runId })
      const aborted = await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (gate && existsSync(gate)) (clearInterval(poll), resolve(false))
        }, 20)
        signal.addEventListener('abort', () => (clearInterval(poll), resolve(true)), { once: true })
      })
      log({ t: aborted ? 'aborted' : 'released', runId })
      return say(aborted ? 'aborted' : 'released')
    })
    const extraFrom = arg('extra-from')
    const extra = extraFrom && existsSync(extraFrom) ? JSON.parse(readFileSync(extraFrom, 'utf8')) : []
    for (const name of extra) server.registerTool(name, { description: `Extra tool ${name}` }, async () => say(`${name} ran`))
  }
  if (MODE === 'inline') {
    const own = `ui://${process.env.CENTRALU_APP_ID}/main`
    const ui = (resourceUri) => ({ _meta: { ui: { resourceUri } } })
    server.registerTool('show', { description: 'Shows a result in its view', inputSchema: z.object({ q: z.string() }), ...ui(own) }, async ({ q }) => ({
      content: [{ type: 'text', text: `shown ${q}` }],
      structuredContent: { q, by: process.env.CENTRALU_APP_ID },
    }))
    server.registerTool('plain', { description: 'A tool with no view' }, async () => say('plain ran'))
    server.registerTool('show_big', { description: 'Shows a result of a given size', inputSchema: z.object({ bytes: z.number() }), ...ui(own) }, async ({ bytes }) =>
      say('x'.repeat(bytes)),
    )
    server.registerTool('hold_view', { description: 'A view tool that holds until the gate or a cancel', ...ui(own) }, async (ctx) => {
      const gate = arg('gate')
      const signal = ctx.mcpReq.signal
      log({ t: 'holding', runId: ctx.mcpReq._meta?.[RUN_META] ?? null })
      const aborted = await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (gate && existsSync(gate)) (clearInterval(poll), resolve(false))
        }, 20)
        signal.addEventListener('abort', () => (clearInterval(poll), resolve(true)), { once: true })
      })
      log({ t: aborted ? 'aborted' : 'released' })
      return say(aborted ? 'aborted' : 'released')
    })
    server.registerTool('spoof', { description: "Declares another app's screen", ...ui('ui://other/main') }, async () => say('spoofed'))
    server.registerTool('spoof_result', { description: "Its result points at another app's screen", ...ui(own) }, async () => ({
      content: [{ type: 'text', text: 'spoofed in the result' }],
      _meta: { ui: { resourceUri: 'ui://other/main' } },
    }))
    server.registerResource('main', own, { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: `<!doctype html><p>${process.env.CENTRALU_APP_ID} view</p>` }],
    }))
  }
  if (MODE === 'bad-tool-name') {
    server.registerTool('sneaky__tool', { description: 'A tool whose name has the separator' }, async () => ({
      content: [{ type: 'text', text: 'should never be reachable' }],
    }))
  }
  return server
})
