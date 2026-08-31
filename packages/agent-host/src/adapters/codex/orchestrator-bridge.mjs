#!/usr/bin/env node
/**
 * Codex ↔ Centralu 다리 (stdio MCP 서버).
 *
 * Codex는 스레드별 config로 **stdio 서버만** 물릴 수 있다 — HTTP(url) 방식은
 * 실측에서 요청이 한 건도 오지 않았다 (codex-cli 0.147.0). 그래서 프로세스가
 * 하나 더 붙는다. Claude는 인프로세스라 이 파일이 필요 없다.
 *
 * **이 다리는 판단을 하지 않는다.** 도구 이름과 인자를 host로 넘기고 글을 받아
 * 그대로 돌려줄 뿐이다. 접근 범위·목록 규칙·표현은 전부 host에 남는다 —
 * 여기에 조금이라도 옮겨 적으면 두 어댑터의 도구가 갈라진다.
 *
 * 이 파일은 codex가 `node <경로>`로 직접 띄우므로 **평범한 .mjs여야 한다**
 * (tsx도 번들도 거치지 않는다).
 *
 * 환경변수로 받는 것:
 *   CC_HOST_URL       host의 WS 주소
 *   CC_HOST_TOKEN     인증 토큰
 *   CC_SESSION_ID     이 오케스트레이터 세션 id (host가 권한을 이걸로 판정한다)
 */
import { WebSocket } from 'ws'

const URL_ = process.env.CC_HOST_URL
const TOKEN = process.env.CC_HOST_TOKEN
const SESSION_ID = process.env.CC_SESSION_ID

/** stdout은 MCP 전용이다 — 진단은 전부 stderr로 (섞이면 프로토콜이 깨진다) */
const log = (...a) => process.stderr.write(`[cc-bridge] ${a.join(' ')}\n`)

let ws = null
let nextId = 1
const pending = new Map()

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(URL_)
    const fail = (e) => reject(e instanceof Error ? e : new Error(String(e)))
    sock.on('error', fail)
    sock.on('message', (raw) => {
      let f
      try {
        f = JSON.parse(String(raw))
      } catch {
        return
      }
      if (f.kind === 'res') {
        const p = pending.get(f.id)
        if (!p) return
        pending.delete(f.id)
        if (f.ok) p.resolve(f.result)
        else p.reject(new Error(f.error?.message ?? 'host error'))
      }
    })
    sock.on('open', () => {
      sock.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
      ws = sock
      resolve(sock)
    })
  })
}

async function rpc(method, params) {
  if (!ws || ws.readyState !== 1) await connect()
  const id = String(nextId++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 타임아웃`))
    }, 60000)
  })
}

// ── MCP (stdio, JSON-RPC 2.0) ────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const err = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })

async function handle(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'centralu', version: '1' },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return ok(id, {})

  if (method === 'tools/list') {
    try {
      // 자기 세션 id를 실어 보낸다 — 매니저 세션(#69)은 부분집합만 받아야 한다
      const tools = await rpc('orchestrator.tools', { sessionId: SESSION_ID })
      return ok(id, { tools })
    } catch (e) {
      return err(id, `도구 목록을 못 받았습니다 — ${e.message}`)
    }
  }

  if (method === 'tools/call') {
    try {
      const r = await rpc('orchestrator.tool', {
        sessionId: SESSION_ID,
        name: params?.name,
        args: params?.arguments ?? {},
      })
      return ok(id, { content: [{ type: 'text', text: r.text }], isError: r.isError === true })
    } catch (e) {
      // 조용히 성공한 척하지 않는다 — 모델이 시켰다고 믿고 넘어가면 사람만 모른다
      return ok(id, { content: [{ type: 'text', text: `도구를 실행하지 못했습니다 — ${e.message}` }], isError: true })
    }
  }

  if (id !== undefined) err(id, `지원하지 않는 메서드: ${method}`)
}

if (!URL_ || !TOKEN || !SESSION_ID) {
  log('CC_HOST_URL·CC_HOST_TOKEN·CC_SESSION_ID가 있어야 합니다')
  process.exit(1)
}

let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg).catch((e) => log('처리 실패:', e.message))
  }
})
process.stdin.on('end', () => process.exit(0))
