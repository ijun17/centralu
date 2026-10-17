/**
 * Keeper scenarios (`keeper-integration.mjs`), step 3: the front door and the blue-green swap, and
 * the drain cutting a slow call.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, bundleInfo, check, HOST_SRC, hostsFor, log, newData, ready, started, startKeeper, tempDirs } from './keeper-integration-harness.mjs'

// ── Step 3: the front door and the blue-green swap ─────────────────────────────────────────────

/**
 * A WebSocket client through the front door, with its hello_ok and a promise for its close. Calls
 * reject with the host's own error message, so a drain's cut can be read back.
 */
async function frontClient(port, token, timeoutMs = 8000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  let next = 1
  let onClose
  const closed = new Promise((r) => (onClose = r))
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello_ok')), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 }))
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data))
      if (f.kind === 'hello_ok') {
        clearTimeout(timer)
        resolve(f)
      } else if (f.kind === 'res' && pending.has(f.id)) {
        const p = pending.get(f.id)
        pending.delete(f.id)
        f.ok ? p.resolve(f.result) : p.reject(Object.assign(new Error(f.error?.message ?? 'rpc failed'), { retryable: f.error?.retryable }))
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    }
  })
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the host closed the connection'))
    pending.clear()
    onClose(Date.now())
  }
  return {
    hello,
    closed,
    open: () => ws.readyState === WebSocket.OPEN,
    call: (method, params, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const id = String(next++)
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, ms)
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        })
        if (ws.readyState !== WebSocket.OPEN) return pending.get(id).reject(new Error('the host is gone'))
        ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
      }),
    close: () => ws.close(),
  }
}

/** Reconnects to the front door until a host greets, the way the UI's rpc-client does */
async function reconnect(port, token, limitMs = 40_000) {
  const end = Date.now() + limitMs
  for (;;) {
    try {
      return await frontClient(port, token, 15_000)
    } catch (e) {
      if (Date.now() > end) throw e
      await sleep(200)
    }
  }
}

/** A second build: the bundled host under another commit, or a stand-in main.mjs */
function makeBuild(commit, mainMjs) {
  const dir = mkdtempSync('/tmp/ck-src-')
  tempDirs.push(dir)
  cpSync(HOST_SRC, dir, { recursive: true })
  writeFileSync(join(dir, 'bundle-info.json'), JSON.stringify({ ...bundleInfo(), commit }))
  if (mainMjs) writeFileSync(join(dir, 'main.mjs'), mainMjs)
  return dir
}

/** The ports a process listens on */
function listening(pid) {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => Number(l.split(':').pop()))
}

/** The environment a process was started with (macOS `ps eww`). Never printed: it holds the token */
function startEnv(pid) {
  return spawnSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? ''
}

/** The swap phases an attached client was told, in order, without repeats */
function phases(app) {
  const seen = []
  for (const l of app.lines) {
    const p = l.view?.swap?.phase
    if (p && seen[seen.length - 1] !== p) seen.push(p)
  }
  return seen
}

const swapOf = async (sock) => (await status(sock))?.swap

/**
 * A session's bridge credential, made the way the host makes it (packages/agent-host/src/transport/
 * bridge-token.ts, #382). Spelled out here rather than imported: this script drives built copies of
 * the host and imports none of its source. If the two drift apart, the swap scenario's bridge checks
 * fail, because the host refuses the credential.
 */
function bridgeToken(hostToken, sessionId) {
  const mac = createHmac('sha256', hostToken).update(`centralu bridge token v1\0${sessionId}`).digest('base64url')
  return `ccb1:${sessionId}:${mac}`
}

/** The Codex bridge from a host copy, spoken to the way codex speaks to it */
function startBridge(copyDir, url, hostToken) {
  const sessionId = 'integration-no-such-session'
  const child = spawn(process.execPath, [join(copyDir, 'codex-orchestrator-bridge.mjs')], {
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

async function scenarioSwap() {
  log('\nblue-green swap through the front door')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  startKeeper(data, { env: { CC_KEEPER_DRAIN_MS: '1500' } })
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
  // The host gets the front door's token on its stdin (#538), so clients keep one token across hosts (c1 below)
  check(!env.includes(token), 'the front door’s token is not in the host’s start environment, which this user’s processes can read (#538)')
  check(env.includes('CC_HOST_TOKEN_ON_STDIN=1'), 'the host is told its token comes on stdin (#538)')

  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const c1 = await frontClient(port, token)
  const p = await c1.call('projects.add', { path: project })
  const copyA = view.source.copyDir
  const bridge = startBridge(copyA, door, token)
  const before = await bridge.ask('tools/list')
  // A result, not an error: a refused credential comes back as an error too (#382)
  check(before?.result, 'a Codex bridge with the front door and its session’s credential in its environment reaches the host', JSON.stringify(before))

  const src2 = makeBuild('swapcommit2')
  const sw = await request(sock, { op: 'switch', source: { commit: 'swapcommit2', hostDir: src2, bundlePath: '/tmp/Other.app' } })
  check(sw.ok, 'switch is accepted')
  const closedAt = await Promise.race([c1.closed, sleep(30_000).then(() => null)])
  check(closedAt, 'the swap closes the connection through the front door')
  const c2 = await reconnect(port, token)
  const reconnectMs = Date.now() - (closedAt ?? Date.now())
  check(
    c2.hello.build?.copyDir === join(data, 'hosts', 'swapcommit2') && c2.hello.streamEpoch !== c1.hello.streamEpoch,
    `the same address and token reach the new host after a reconnect (${reconnectMs} ms), on a new stream epoch`,
    JSON.stringify(c2.hello.build),
  )
  const projects = await c2.call('projects.list', {})
  check(projects.some((x) => x.id === p.id), 'the new host serves the same store')
  const done = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'done' && s
  }, 10_000)
  check(done, 'the swap reports done')
  const seen = phases(app)
  const order = ['starting', 'standby', 'draining', 'activating', 'done']
  check(order.every((ph, i) => seen.indexOf(ph) >= 0 && (i === 0 || seen.indexOf(ph) > seen.indexOf(order[i - 1]))), 'the attached app was told every phase, in order', seen.join(' > '))
  const after = await status(sock)
  check(after.status.port === port && after.status.token === token, 'the front door’s port and token did not change')
  check(!alive(view.hostPid), 'the old host is gone')
  const hosts = hostsFor(data)
  check(hosts.length === 1 && hosts[0].command.includes(join(data, 'hosts', 'swapcommit2', 'main.mjs')), 'one host remains, running from the new build’s per-build copy', JSON.stringify(hosts))
  check(await waitFor(() => !existsSync(copyA), 5000), 'the old build’s copy is removed afterwards')
  const later = await bridge.ask('tools/list')
  const text = JSON.stringify(later)
  check(later?.result, 'the same bridge process reaches the new host on its next call, which accepts its credential', text)
  bridge.kill()
  c2.close()

  // A broken build: it fails its start check, and the running host never notices
  log('\na swap to a broken build')
  const c3 = await frontClient(port, token)
  const hostBefore = after.hostPid
  const broken = makeBuild('brokencommit', "console.log('this build is broken: it cannot even start'); process.exit(1)\n")
  await request(sock, { op: 'switch', source: { commit: 'brokencommit', hostDir: broken } })
  const failed = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'failed' && s.target.commit === 'brokencommit' && s
  }, 30_000)
  check(failed && /cannot even start/.test(failed.message) && failed.rolledBack === false, 'the failure is reported with the build’s own words, without a rollback', JSON.stringify(failed))
  check(c3.open() && (await c3.call('projects.list', {})).some((x) => x.id === p.id), 'a client connected through the front door kept being served throughout')
  check((await status(sock)).hostPid === hostBefore && alive(hostBefore), 'the running host was not touched')
  check(!existsSync(join(data, 'hosts', 'brokencommit')), 'the broken build’s copy is removed')
  c3.close()

  // B passes standby, then fails after A drained: A's build is started again
  log('\na new host that fails after the old one drained')
  const fails = makeBuild(
    'failsoncommit',
    [
      "if (process.argv.includes('--standby')) {",
      "  console.log(JSON.stringify({ standby: { pid: process.pid } }))",
      "  process.stdin.on('data', (d) => { if (String(d).includes('activate')) { console.log('simulated failure while taking over'); process.exit(1) } })",
      "} else { console.log('this build never starts'); process.exit(1) }",
      '',
    ].join('\n'),
  )
  await request(sock, { op: 'switch', source: { commit: 'failsoncommit', hostDir: fails } })
  const rolled = await waitFor(async () => {
    const s = await swapOf(sock)
    return s?.phase === 'failed' && s.target.commit === 'failsoncommit' && s
  }, 40_000)
  check(rolled && rolled.rolledBack === true && /simulated failure/.test(rolled.message), 'the failure after the drain is reported, with the previous build started again', JSON.stringify(rolled))
  const back = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v.source?.commit === 'swapcommit2' && v.hostPid && v.hostPid !== hostBefore && alive(v.hostPid) && v
  }, 30_000)
  const runningNow = hostsFor(data)
  check(
    back && runningNow.length === 1 && runningNow[0].pid === back.hostPid && runningNow[0].command.includes(join(data, 'hosts', 'swapcommit2', 'main.mjs')),
    'the previous build serves again, as a new process from its own copy',
    JSON.stringify({ source: back?.source, runningNow }),
  )
  const c4 = await reconnect(port, token)
  check((await c4.call('projects.list', {})).some((x) => x.id === p.id), 'through the same front door, on the same store')
  c4.close()
  await request(sock, { op: 'stop' }).catch(() => {})
}

/**
 * A user-folder app whose one tool never answers in time: a plain stdio JSON-RPC server, so the
 * test needs no SDK. Called through `apps.invoke`, the host serves the call itself, which is exactly
 * what a drain has to bound.
 */
function plantSlowApp(data) {
  const dir = join(data, 'apps', 'slowapp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'centralu.app.json'),
    JSON.stringify({ manifestVersion: 1, id: 'slowapp', name: 'Slow app', version: '0.1.0', description: 'never answers in time', server: { command: process.execPath, args: ['server.mjs'] } }),
  )
  writeFileSync(
    join(dir, 'server.mjs'),
    [
      "let buf = ''",
      "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
      "process.stdin.on('data', (d) => {",
      '  buf += d',
      "  for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {",
      '    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)',
      "    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'slowapp', version: '1' } } })",
      "    else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'slow', description: 'Takes a minute', inputSchema: { type: 'object', properties: {} } }] } })",
      "    else if (m.method === 'tools/call') setTimeout(() => send({ id: m.id, result: { content: [{ type: 'text', text: 'finally' }] } }), 60000)",
      "    else if (m.method === 'ping') send({ id: m.id, result: {} })",
      '  }',
      '})',
      "process.stdin.on('end', () => process.exit(0))",
      '',
    ].join('\n'),
  )
}

async function scenarioDrainCutsSlowCall() {
  log('\nthe drain bounds a slow call the host serves itself')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  plantSlowApp(data)
  const BOUND = 1500
  startKeeper(data, { env: { CC_KEEPER_DRAIN_MS: String(BOUND) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'x' })
  await app.first()
  const c = await frontClient(view.status.port, view.status.token)
  const apps = await c.call('apps.list', {})
  if (!check(apps.some((a) => a.appId === 'slowapp'), 'the slow app is installed', JSON.stringify(apps.map((a) => a.appId)))) return
  const t0 = Date.now()
  const slow = c.call('apps.invoke', { appId: 'slowapp', name: 'slow', args: {} }, 60_000).then(
    (v) => ({ ok: true, v, at: Date.now() }),
    (e) => ({ ok: false, e, at: Date.now() }),
  )
  await sleep(800)
  const src2 = makeBuild('afterdrain')
  const drainAsked = Date.now()
  await request(sock, { op: 'switch', source: { commit: 'afterdrain', hostDir: src2 } })
  const r = await slow
  const waited = r.at - drainAsked
  check(
    !r.ok && /stopped waiting for this call after 1\.5s/.test(r.e.message) && r.e.retryable === true,
    'the call still running at the bound is answered with a retryable error that says why',
    r.ok ? JSON.stringify(r.v) : `${r.e.message} (retryable ${r.e.retryable})`,
  )
  check(waited >= BOUND - 200 && waited < BOUND + 8000, `the old host waited out the bound (${BOUND} ms) and no longer (${waited} ms after the switch, ${r.at - t0} ms after the call)`)
  const done = await waitFor(async () => {
    const s = await swapOf(sock)
    return (s?.phase === 'done' || s?.phase === 'failed') && s
  }, 30_000)
  check(done?.phase === 'done' && done.cut?.includes('rpc apps.invoke'), 'the swap completes and reports what it cut', JSON.stringify(done))
  await request(sock, { op: 'stop' }).catch(() => {})
}

export { scenarioSwap, scenarioDrainCutsSlowCall }
