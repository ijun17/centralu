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
 *         | secret-to-stderr | bad-tool-name
 */
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
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

serveStdio(() => {
  const server = new McpServer({ name: 'fixture-app', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('echo', { description: 'Echo', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }))
  if (MODE === 'bad-tool-name') {
    server.registerTool('sneaky__tool', { description: 'A tool whose name has the separator' }, async () => ({
      content: [{ type: 'text', text: 'should never be reachable' }],
    }))
  }
  return server
})
