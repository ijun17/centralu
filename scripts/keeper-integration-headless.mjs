/**
 * The headless keeper `centralu serve` starts on Linux (docs/plans/remote-keeper.md §8, step 3), with the real binary and the
 * real host (`keeper-integration.mjs`; CI's `keeper e2e (linux)` runs it): started the way `serve` starts it, with the port, the
 * Node and the host folder as arguments, the key as the first line on its stdin and `CC_SERVE=1` in its environment.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, openSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { alive, hostClient, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { BIN, check, HOST_SRC, helloOk, hostsFor, log, newData, started, tempDirs } from './keeper-integration-harness.mjs'

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** `centralu-keeper --headless ...` as `runServe` starts it; resolves once the ready line came (or the keeper ended first) */
async function startHeadless(data) {
  const port = await freePort()
  const key = randomBytes(16).toString('hex')
  const logFd = openSync(join(data, 'keeper.log'), 'a')
  const child = spawn(
    BIN,
    ['--headless', '--data-dir', data, '--port', String(port), '--node', process.execPath, '--host-source', HOST_SRC, '--app-version', '0.0.0-test'],
    // A group of its own, a pipe for stdin and stdout, and the log for stderr: the launcher's
    { detached: true, stdio: ['pipe', 'pipe', logFd], env: { ...process.env, CC_DATA_DIR: data, CC_SERVE: '1' } },
  )
  started.add(child.pid)
  child.stdin.write(`${JSON.stringify({ key })}\n`)
  const lines = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  const line = await waitFor(() => lines.find((l) => l.includes('"ready"')), 40_000)
  return { pid: child.pid, child, port, key, sock: join(data, 'keeper.sock'), exited, lines, ready: line ? JSON.parse(line) : null }
}

const hostLog = (data) => {
  try {
    return readFileSync(join(data, 'host.log'), 'utf8')
  } catch {
    return ''
  }
}

async function scenarioHeadless() {
  log('\nthe headless keeper (centralu serve on Linux)')
  const data = newData()
  const k = await startHeadless(data)
  if (!check(k.ready, 'it says it is ready', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000))) return
  check(k.ready.port === k.port && !JSON.stringify(k.ready).includes(k.key), 'on the port it was given, and the line carries no token', JSON.stringify(k.ready))
  const hostPid = k.ready.hostPid
  check(hostsFor(data).length === 1 && hostsFor(data)[0].pid === hostPid, 'the host it names is the one running', JSON.stringify(hostsFor(data)))
  try {
    const hello = await helloOk(k.port, k.key)
    check(hello?.kind === 'hello_ok', 'the key serve gave it is the token on that port')
  } catch (e) {
    check(false, 'the key serve gave it is the token on that port', String(e))
  }
  const lock = JSON.parse(readFileSync(join(data, 'host.lock'), 'utf8'))
  check(lock.pid === hostPid && lock.by === 'serve', 'host.lock names the host and says serve started it, which --stop trusts', JSON.stringify(lock))
  const view = await status(k.sock)
  check(view?.rights === 'limited' && view.status?.token !== k.key, 'a process asking it for status gets the limited credential, never the key', JSON.stringify(view?.rights))
  const sw = await request(k.sock, { op: 'switch', source: { commit: 'abc' } })
  check(sw.ok === false && String(sw.error).includes('window_only'), 'nothing is a window to it: switch is refused to this process too (#1405)', JSON.stringify(sw))

  // Busy: an open terminal. stop { ifIdle } leaves everything as it is
  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const host = await hostClient(k.port, k.key)
  try {
    const p = await host.call('projects.add', { path: project })
    const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
    check(await waitFor(async () => (await status(k.sock)).busy, 15_000, 250), 'an open terminal is reported as activity')
    const refused = await request(k.sock, { op: 'stop', ifIdle: true })
    check(refused.ok === false && refused.busy === true, 'stop { ifIdle } with a terminal open is refused: busy', JSON.stringify(refused))
    check(refused.activity?.terminals === 1, 'and says what runs', JSON.stringify(refused.activity))
    await sleep(500)
    check(alive(k.pid) && alive(hostPid), 'the keeper and the host go on')
    check(Array.isArray(await host.call('sessions.list', {})), 'and the host still takes calls')
    await host.call('terminal.close', { terminalId: term.terminalId })
  } catch (e) {
    check(false, 'the host takes a project and a terminal', String(e))
  } finally {
    host.close()
  }
  // A headless keeper is never idle for the lack of a window (idle_decision), however long
  await sleep(3000)
  check(alive(k.pid), 'with no window ever attached it is still there')

  check(await waitFor(async () => !(await status(k.sock)).busy, 15_000, 250), 'with the terminal closed it reports idle')
  const yes = await request(k.sock, { op: 'stop', ifIdle: true })
  check(yes.ok === true, 'stop { ifIdle } with nothing running is accepted', JSON.stringify(yes))
  const gone = await waitFor(() => !alive(k.pid) && !alive(hostPid), 30_000)
  check(gone, 'and ends the keeper and the host', `keeper ${alive(k.pid)}, host ${alive(hostPid)}`)
  check(hostLog(data).includes(`[agent-host] shutting down (pid ${hostPid}, stopped)`), 'the host stopped through its own shutdown, as host.stop does')
  check(!hostLog(data).includes('shutting down now'), 'with nothing forced')
  check((await k.exited).code === 0, 'the keeper exits 0')
}

/** A stop that is for an update reaches the host as one, so it lists the turns it ends for the next */
async function scenarioHeadlessStopForUpdate() {
  log('\nthe headless keeper: stop for an update, a signal, the launcher gone')
  const data = newData()
  const k = await startHeadless(data)
  if (!check(k.ready, 'it says it is ready')) return
  const stop = await request(k.sock, { op: 'stop', forUpdate: true })
  check(stop.ok === true, 'stop { forUpdate } is accepted')
  check(await waitFor(() => !alive(k.pid) && !alive(k.ready.hostPid), 30_000), 'the keeper and the host end')
  check(hostLog(data).includes('asked to stop (centralu serve --stop, for an update)'), 'and the host was told it was for an update', hostLog(data).slice(-600))

  // SIGTERM, which is what the launcher passes on for its own: the same stop, in order
  const d2 = newData()
  const s = await startHeadless(d2)
  if (!check(s.ready, 'a second one says it is ready')) return
  process.kill(s.pid, 'SIGTERM')
  check(await waitFor(() => !alive(s.pid) && !alive(s.ready.hostPid), 30_000), 'SIGTERM ends the keeper and the host')
  check(hostLog(d2).includes(`[agent-host] shutting down (pid ${s.ready.hostPid}, stopped)`), 'in order, not killed')
  check((await s.exited).code === 0, 'with exit 0')

  // The launcher gone however it went (its pipe closes): the same, so no host is left unowned
  const d3 = newData()
  const g = await startHeadless(d3)
  if (!check(g.ready, 'a third one says it is ready')) return
  g.child.stdin.end()
  check(await waitFor(() => !alive(g.pid) && !alive(g.ready.hostPid), 30_000), 'the launcher’s pipe closing ends the keeper and the host')
  check(hostLog(d3).includes(`[agent-host] shutting down (pid ${g.ready.hostPid}, stopped)`), 'in order, not killed')
}

export { scenarioHeadless, scenarioHeadlessStopForUpdate }
