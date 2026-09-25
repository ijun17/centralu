/**
 * 외부 앱 런타임 테스트의 앱 (M4 A). 진짜 자식 프로세스로 뜨는 진짜 MCP 서버다 —
 * v2 서버 SDK를 워크스페이스에서 그대로 가져온다(스파이크 S-5의 app-node와 같은 모양).
 *
 *   node app.mjs --log <jsonl> [--mode <mode>]
 *
 * --log   이 프로세스가 본 것을 한 줄에 하나씩 JSON으로 남긴다. 테스트는 이 파일로
 *         "몇 번 떴나", "어떤 메서드가 왔나", "어떤 환경을 받았나"를 센다 — host의 말이
 *         아니라 앱이 실제로 겪은 것을 본다.
 * --mode  normal | crash-on-start | ignore-eof | grandchild | hold-fd3 | flood-stderr
 *         | secret-to-stderr | bad-tool-name | mediation | view | attach
 *
 * `attach`는 A-5(세션에 붙이기)를 위한 묶음이다: 주석이 다른 도구들(읽기 전용 `peek`, 바꾸는
 * `poke`), 화면 전용 도구, 문(`--gate <파일>`)이 생길 때까지 붙드는 `hold`, 그리고 기동할 때
 * `--extra-from <파일>`에 적힌 이름들로 더하는 도구(도구 목록이 바뀌는 앱).
 *
 * `mediation`은 A-4를 위한 도구 묶음을 연다: 공개 범위가 다른 도구들, 받은 실행 id를 돌려주는
 * 도구, 취소를 기다리는 도구, 실패·죽는 도구, 그리고 fd 3의 중개를 부르는 도구. 중개 클라이언트는
 * 템플릿 도우미의 모양 그대로다(S-5): fd 3 소켓을 unref하고, 받은 실행 id를 되돌려 붙인다.
 *
 * `view`는 화면(B-3)이 받는 모양을 시험한다: 상태를 서버에 두는 앱(간격 하나), 결과의
 * `structuredContent`·`isError`·`_meta`, CSP를 선언한 `ui://` 문서. 고정 화면(B-2)의 home 후보들도
 * 여기 있다(`home`, `no_screen`, `agent_home`, `bad_home`, `failing_home`).
 *
 * `inline`은 대화 안 화면(B-1)을 위한 묶음이다: 자기 화면(`ui://<앱 id>/main`)을 선언한 에이전트 도구
 * (`show`, 결과의 크기를 고르는 `show_big`, 문이 열릴 때까지 붙드는 `hold_view`), 화면 없는 도구(`plain`),
 * 남의 화면을 대는 도구(`spoof`는 선언에서, `spoof_result`는 결과에서 `ui://other/main`을 가리킨다).
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
  // 표준 입력이 닫혀도 이 타이머가 프로세스를 붙든다 — 종료 규칙의 "유예 뒤 트리 끝내기"를 시험한다
  setInterval(() => {}, 1000)
}
if (MODE === 'hold-fd3') {
  // unref하지 않은 fd 3 — S-5에서 Node 앱이 끝나지 않았던 모양 그대로다. host가 fd 3을
  // 닫으면('end') 우리도 닫고, 그때서야 프로세스가 끝날 수 있다
  const sock = new net.Socket({ fd: 3, readable: true, writable: true })
  sock.on('end', () => sock.end())
  sock.on('error', () => {})
}
if (MODE === 'ignore-eof' || MODE === 'grandchild') {
  // 같은 그룹의 손주 — host가 트리째 끝내지 않으면 고아로 남는다
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  // 손주의 핸들이 이 프로세스를 붙들지 않게 — 'grandchild'는 스스로 잘 끝나되 손주를 남기는 앱이다
  kid.unref()
  log({ t: 'grandchild', grandchild: kid.pid })
}

// 들어온 요청의 메서드를 적는다 — 세대 탐색(`server/discover`)이 왔는지를 테스트가 본다.
// SDK의 리스너와 같은 틱에 붙이므로 SDK가 놓치는 조각은 없다
process.stdin.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\n')) {
    try {
      const m = JSON.parse(line)
      if (m.method) log({ t: 'method', method: m.method })
    } catch {
      // 줄이 조각났다 — 세는 데만 쓰는 탭이라 버린다
    }
  }
})

const RUN_META = 'centralu/runId'
let brokerP
/** fd 3 위의 중개 클라이언트 — 처음 부를 때 붙는다 */
function broker() {
  brokerP ??= (async () => {
    const sock = new net.Socket({ fd: 3, readable: true, writable: true })
    // fd 3 혼자서 앱을 붙들면 안 된다 — 표준 입력의 EOF가 "끝내라"다 (S-5)
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
    // 입력 스키마가 없는 도구의 핸들러는 v2에서 ctx 하나만 받는다
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
     * 중개를 부르는 도구. `args`를 주면 그대로 싣고(없으면 도구마다 정해 둔 인자), `timeoutMs`를 주면 그 상한에 진행 알림이
     * 오면 다시 세게 한다(`resetTimeoutOnProgress`) — host가 기다리는 부탁을 살려 두는지 본다. 결과는 글 한 줄과 함께
     * `structuredContent`에 중개의 답을 그대로 싣는다(isError·text·structured).
     */
    server.registerTool(
      'ask_broker',
      {
        description: 'Calls the host broker on fd 3',
        inputSchema: z.object({
          mode: z.enum(['run', 'run-nosignal', 'run-detached', 'none', 'given']),
          runId: z.string().optional(),
          tool: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
          timeoutMs: z.number().optional(),
        }),
      },
      async ({ mode, runId, tool, args: given, timeoutMs }, ctx) => {
        const own = ctx.mcpReq._meta?.[RUN_META]
        const meta = mode === 'none' ? {} : { [RUN_META]: mode === 'given' ? runId : own }
        const c = await broker()
        const name = tool ?? 'run_agent'
        if (mode === 'run-detached') {
          // 부탁이 중개에 닿을 만큼만 기다리고, 결과는 기다리지 않고 답한다 — 부탁한 일이
          // 부탁한 실행보다 오래 살려고 하는 앱
          void c.callTool({ name, arguments: given ?? { prompt: 'fire and forget' }, _meta: meta }).catch(() => {})
          await new Promise((r) => setTimeout(r, 150))
          return say('detached')
        }
        const args = given ?? { run_agent: { prompt: 'summarize this' }, call_app: { app: 'other', tool: 'echo' }, host_data: { query: 'sessions' } }[name]
        const r = await c.callTool(
          { name, arguments: args, _meta: meta },
          {
            ...(mode === 'run' ? { signal: ctx.mcpReq.signal } : {}),
            ...(timeoutMs
              ? { timeout: timeoutMs, resetTimeoutOnProgress: true, onprogress: (p) => log({ t: 'broker-progress', message: p.message ?? null }) }
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
    // 고정 화면(B-2)의 home 후보들: 화면을 선언한 도구, 화면이 없는 도구, 에이전트에게만 열린 화면 도구,
    // ui://가 아닌 곳을 가리키는 도구. home은 부를 때마다 적는다 — host가 정말 불렀는지를 시험이 센다
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
