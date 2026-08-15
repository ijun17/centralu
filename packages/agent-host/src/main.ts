import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ToolName } from '@cc/protocol'
import { HostServer } from './transport/server.js'
import { SessionManager } from './sessions/manager.js'
import { Store } from './dev-services/store.js'
import { ClaudeAdapter } from './adapters/claude/index.js'
import type { AgentAdapter } from './adapters/contract.js'
import { createRpcHandler } from './rpc.js'

/**
 * Agent Host 진입점.
 * dev: `pnpm host` 로 직접 실행. prod: Tauri가 사이드카로 spawn (docs/architecture.md §4)
 */
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    db: { type: 'string' },
    memory: { type: 'boolean', default: false },
  },
})

const token = values.token ?? process.env.CC_HOST_TOKEN ?? randomBytes(16).toString('hex')
const dbPath = values.memory
  ? ':memory:'
  : (values.db ?? defaultDbPath())

function defaultDbPath(): string {
  const dir = join(homedir(), '.control-center')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'store.db')
}

const store = new Store(dbPath)
const adapters = new Map<ToolName, AgentAdapter>([['claude', new ClaudeAdapter()]])

const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  onRpc: createRpcHandler(mgr, adapters),
})

let port: number
try {
  port = await server.listen()
} catch (err) {
  console.error(`\n[agent-host] 기동 실패\n${(err as Error).message}\n`)
  process.exit(1)
}
// 이 줄은 Tauri 수퍼바이저가 파싱한다 (포트·토큰 전달 경로)
console.log(JSON.stringify({ ready: true, port, token, db: dbPath }))

const shutdown = async () => {
  await mgr.disposeAll()
  await server.close()
  store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
