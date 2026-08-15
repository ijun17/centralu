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
import { CodexAdapter } from './adapters/codex/index.js'
import type { AgentAdapter } from './adapters/contract.js'
import { createRpcHandler } from './rpc.js'
import { ensureToolPath } from './env-path.js'

/**
 * Agent Host 진입점.
 * dev: `pnpm host` 로 직접 실행. prod: Tauri가 사이드카로 spawn (docs/architecture.md §4)
 */
// GUI 앱은 로그인 셸 PATH를 물려받지 못한다 — CLI를 찾으려면 먼저 보강해야 한다 (실측).
// 사용자의 로그인 셸에게 직접 물어보므로 nvm·mise·수동 설치도 잡힌다.
const pathResult = ensureToolPath()
if (pathResult.source !== 'unchanged') {
  console.error(`[agent-host] PATH 보강 (${pathResult.source === 'shell' ? '로그인 셸' : '기본 후보'})`)
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    db: { type: 'string' },
    /** 부모가 죽으면 함께 종료 (Tauri 수퍼바이저가 켠다) */
    'watch-parent': { type: 'boolean' },
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
const adapters = new Map<ToolName, AgentAdapter>([
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
])

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

/**
 * 부모(Tauri 수퍼바이저)가 사라지면 스스로 종료한다.
 *
 * 수퍼바이저가 stdin을 파이프로 열어두므로, 앱이 어떤 이유로 죽든 — 정상 종료든
 * 크래시든 SIGKILL이든 — 이 파이프가 닫히고 EOF가 온다. 종료 훅에만 기대면
 * 강제 종료 시 host가 고아로 남아 포트를 물고 있게 된다 (실측으로 확인).
 * **명시적 플래그로만 켠다** — stdin이 /dev/null인 경우(다른 스크립트가 띄울 때)에도
 * EOF가 즉시 오므로, TTY 여부로 판단하면 엉뚱하게 자살한다 (실측으로 확인).
 */
if (values['watch-parent']) {
  process.stdin.resume()
  const onParentGone = () => {
    console.error('[agent-host] 부모 프로세스가 종료되어 함께 종료합니다')
    void shutdown()
  }
  process.stdin.on('end', onParentGone)
  process.stdin.on('close', onParentGone)
  process.stdin.on('error', onParentGone)
}
