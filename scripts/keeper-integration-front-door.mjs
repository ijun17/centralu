/**
 * Keeper scenario (`keeper-integration.mjs`): step 3's front door, which outlived the blue-green swap (#1895 step 4,
 * PR 4). Clients and the host's Codex bridge are given the door's address and token, never the host's own, the token
 * reaches the host on its stdin and not in its environment, and when the host restarts (a crash) the same address and
 * token reach the next host run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostClient, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, bundleInfo, check, HOST_SRC, log, newData, ready, started, startKeeper } from './keeper-integration-harness.mjs'

/** The ports a process listens on */
function listening(pid) {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => Number(l.split(':').pop()))
}

/** The environment a process was started with (`ps eww`). Never printed: it holds the token */
function startEnv(pid) {
  return spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? ''
}

/**
 * A session's bridge credential, made the way the host makes it (packages/agent-host/src/transport/bridge-token.ts, #382).
 * Spelled out here rather than imported: this script drives built copies of the host and imports none of its source. If
 * the two drift apart, the bridge check fails, because the host refuses the credential.
 */
function bridgeToken(hostToken, sessionId) {
  const mac = createHmac('sha256', hostToken).update(`centralu bridge token v1\0${sessionId}`).digest('base64url')
  return `ccb1:${sessionId}:${mac}`
}

/** The Codex bridge from a host copy, spoken to the way codex speaks to it */
function startBridge(copyDir, url, hostToken) {
  const sessionId = 'integration-no-such-session'
  const child = spawn(process.execPath, [join(copyDir, 'codex-centralu-bridge.mjs')], {
    env: { ...process.env, CC_HOST_URL: url, CC_BRIDGE_TOKEN: bridgeToken(hostToken, sessionId), CC_SESSION_ID: sessionId },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  started.add(child.pid)
  const got = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      got.push(JSON.parse(buf.slice(0, nl)))
      buf = buf.slice(nl + 1)
    }
  })
  let id = 0
  return {
    ask: async (method, params = {}) => {
      const my = ++id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
      return waitFor(() => got.find((m) => m.id === my), 20_000)
    },
    kill: () => child.kill('SIGKILL'),
  }
}

/** Reconnects to the front door until a host greets, the way the UI's rpc-client does */
async function reconnect(port, token, limitMs = 40_000) {
  const end = Date.now() + limitMs
  for (;;) {
    try {
      return await hostClient(port, token, 15_000)
    } catch (e) {
      if (Date.now() > end) throw e
      await sleep(200)
    }
  }
}

async function scenarioFrontDoor() {
  log('\nthe front door, across a host restart')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000))) return
  const info = bundleInfo()
  const app = attachClient(sock, { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC })
  await app.first()
  const { port, token } = view.status
  const door = `ws://127.0.0.1:${port}`

  check(JSON.parse(readFileSync(join(data, 'keeper.json'), 'utf8')).frontDoor === door, 'keeper.json names the front door (and no token)')
  check(!listening(view.hostPid).includes(port) && listening(view.hostPid).length > 0, 'clients are given the front door, not the host’s own port', `door ${port}, host listens on ${listening(view.hostPid)}`)
  const env = startEnv(view.hostPid)
  check(env.includes(`CC_FRONT_DOOR=${door}`), 'the host is told the front door, which it gives the Codex bridge')
  check(!env.includes(token), 'the front door’s token is not in the host’s start environment, which this user’s processes can read (#538)')
  check(env.includes('CC_HOST_TOKEN_ON_STDIN=1'), 'the host is told its token comes on stdin (#538)')

  const c1 = await hostClient(port, token)
  const bridge = startBridge(view.source.copyDir, door, token)
  const before = await bridge.ask('tools/list')
  // A result, not an error: a refused credential comes back as an error too (#382)
  check(before?.result, 'a Codex bridge with the front door and its session’s credential reaches the host', JSON.stringify(before))

  // The host crashes: the keeper starts the next run behind the same door
  process.kill(view.hostPid, 'SIGKILL')
  const closed = await Promise.race([c1.closedAt, sleep(15_000).then(() => null)])
  check(closed, 'a client connected through the door sees its connection end with the host')
  const next = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v.hostPid !== view.hostPid && v
  }, 30_000)
  check(next && next.status.port === port && next.status.token === token, 'the next host run is behind the same address and token', JSON.stringify(next?.status?.port))
  const c2 = await reconnect(port, token).catch(() => null)
  check(c2, 'a client reconnecting to the same address with the same token reaches it')
  const after = await bridge.ask('tools/list')
  check(after?.result, 'the bridge started before the restart reaches the next run on its next call, which takes its credential (#382)', JSON.stringify(after))
  c2?.close?.()
  bridge.kill()
  app.kill()
}

export { scenarioFrontDoor }
