import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import type { ToolName } from '@cc/protocol'
import { HostServer } from './transport/server.js'
import { SessionManager } from './sessions/manager.js'
import { Store } from './dev-services/store.js'
import { ClaudeAdapter } from './adapters/claude/index.js'
import { CodexAdapter } from './adapters/codex/index.js'
import type { AgentAdapter } from './adapters/contract.js'
import { createRpcHandler } from './rpc.js'
import { TerminalService } from './dev-services/terminal.js'
import { ensureToolPath } from './env-path.js'
import { acquireInstanceLock } from './dev-services/instance-lock.js'

/**
 * Agent Host 진입점.
 * dev: `pnpm host` 로 직접 실행. prod: Tauri가 사이드카로 spawn (docs/architecture.md §4)
 */
// GUI 앱은 로그인 셸 PATH를 물려받지 못한다 — CLI를 찾으려면 먼저 보강해야 한다 (실측).
// 사용자의 로그인 셸에게 직접 물어보므로 nvm·mise·수동 설치도 잡힌다.
const pathResult = ensureToolPath()
if (pathResult.source !== 'unchanged') {
  console.error(`[agent-host] PATH augmented (${pathResult.source === 'shell' ? 'login shell' : 'default candidates'})`)
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

/**
 * 데이터 폴더.
 *
 * **dev와 배포 앱은 서로 다른 폴더를 쓴다.** 같은 폴더를 쓰면 둘을 동시에 켰을 때
 * host 두 개가 같은 store.db를 붙잡고, 각자 다른 세션 목록을 들고 있게 된다.
 * 개발 중에는 배포 앱을 켜둔 채로 dev를 띄우는 게 자연스러우므로 아예 갈라 둔다.
 */
function defaultDbPath(): string {
  // 번들된 산출물로 실행되면 배포, 소스에서 실행되면 dev (수퍼바이저가 알려준다)
  const isDev = process.env.CC_DEV === '1'
  const dir = join(homedir(), isDev ? '.control-center-dev' : '.control-center')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'store.db')
}

/**
 * 같은 데이터 폴더에 host가 둘이면 세션 목록이 어긋나고 SQLite가 경합한다.
 * 조용히 이상해지는 것보다 뜨지 않고 이유를 말하는 편이 낫다.
 */
const lock = acquireInstanceLock(dbPath)
if (!lock.ok) {
  console.error(
    `[agent-host] Another Control Center is already using this data (pid ${lock.heldByPid}).\n` +
      `  Two hosts on the same folder will desync session lists.\n` +
      `  Close the running window first, or use pnpm app:dev while developing (it uses a separate data folder).`,
  )
  process.exit(1)
}
process.on('exit', lock.release)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    lock.release()
    process.exit(0)
  })
}

const store = new Store(dbPath)
const adapters = new Map<ToolName, AgentAdapter>([
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
])

const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
const terminals = new TerminalService((f) => server.pushTerminal(f))
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  onRpc: createRpcHandler(mgr, adapters, terminals),
})

let port: number
try {
  port = await server.listen()
} catch (err) {
  console.error(`\n[agent-host] failed to start\n${(err as Error).message}\n`)
  process.exit(1)
}
// 이 줄은 Tauri 수퍼바이저가 파싱한다 (포트·토큰 전달 경로)
console.log(JSON.stringify({ ready: true, port, token, db: dbPath }))

/**
 * 거절 하나로 죽지 않는다.
 *
 * Node는 미처리 거절이 뜨면 **프로세스를 종료한다.** 이 host는 모든 세션의 부모라,
 * 어딘가에서 새어 나온 거절 하나가 **살아 있는 세션 전부를 끊는다** —
 * 프로젝트를 추가하다가 관계없는 세션들이 함께 끊긴 일이 실제로 있었다.
 * 게다가 stderr는 배포된 앱에서 아무 데도 남지 않아, 왜 죽었는지조차 알 수 없었다.
 *
 * 그래서 두 가지를 한다:
 *   1. 거절은 **삼키지 않고 크게 적되** 살려 둔다. 대개 한 요청의 문제이지
 *      프로세스 전체가 못 쓰게 된 상황은 아니다. 세션을 다 끊는 대가가 훨씬 크다.
 *   2. 예외·거절을 **파일로 남긴다.** 다음에 같은 일이 생기면 추측하지 않아도 된다.
 *
 * uncaughtException은 상태가 깨졌을 수 있어 다르다 — 남기고 정상 경로로 내려간다.
 */
const crashLog = join(dirname(dbPath), 'host-errors.log')

function record(kind: string, err: unknown): void {
  const e = err as Error
  const line = `[${new Date().toISOString()}] ${kind}: ${e?.stack ?? String(err)}\n`
  console.error(`[agent-host] ${kind}`, e?.stack ?? err)
  try {
    appendFileSync(crashLog, line)
  } catch {
    // 로그도 못 남기는 상황이면 stderr가 마지막 수단이다 — 여기서 또 던지지 않는다
  }
}

process.on('unhandledRejection', (reason) => record('Unhandled rejection', reason))
process.on('uncaughtException', (err) => {
  record('Uncaught exception', err)
  void shutdown()
})

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
    console.error('[agent-host] parent process exited; shutting down')
    void shutdown()
  }
  process.stdin.on('end', onParentGone)
  process.stdin.on('close', onParentGone)
  process.stdin.on('error', onParentGone)
}
