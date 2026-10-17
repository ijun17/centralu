/**
 * Keeper scenarios (`keeper-integration.mjs`): the keeper and its host with background mode off and
 * on, stop, a busy host holding off the idle limit, and a keeper killed outright.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, bundleInfo, check, FAKE_BUNDLE, helloOk, HOST_SRC, hostClient, hostsFor, keyOf, log, newData, ready, startKeeper, tempDirs } from './keeper-integration-harness.mjs'

async function scenarioBackgroundOff() {
  log('\nbackground off (the default)')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k1 = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000))) return

  const info = bundleInfo()
  const copy = join(data, 'hosts', keyOf(info.commit, info.builtAt))
  check(view.source?.copyDir === copy, 'the host runs from its per-build copy', `copyDir ${view.source?.copyDir}, expected ${copy}`)
  check(existsSync(join(copy, 'main.mjs')), 'the copy holds the host')
  const hosts = hostsFor(data)
  check(
    hosts.length === 1 && hosts[0].command.includes(`${copy}/main.mjs`) && !hosts[0].command.includes(HOST_SRC),
    'the host process runs the copy, not the bundle',
    JSON.stringify(hosts),
  )
  check((statSync(sock).mode & 0o777) === 0o600, 'the control socket is user-only (0600)', (statSync(sock).mode & 0o777).toString(8))
  check(!readFileSync(join(data, 'keeper.json'), 'utf8').includes(view.status.token), 'keeper.json holds no token')

  const app = attachClient(sock, { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC })
  const first = await app.first()
  check(first?.ok === true && first.sameBuild === true, 'a client attaches and is told it is the same build', JSON.stringify(first))
  const port = first?.view?.status?.port
  const token = first?.view?.status?.token
  check(port > 0 && typeof token === 'string' && token.length > 0, 'the attach answer carries the host port and token')
  try {
    const hello = await helloOk(port, token)
    check(
      hello.build?.commit === info.commit && hello.build?.bundlePath === FAKE_BUNDLE && hello.build?.copyDir === copy,
      "the host's hello_ok names its build and where it came from",
      JSON.stringify(hello.build),
    )
  } catch (e) {
    check(false, "the host's WebSocket answers hello_ok", String(e))
  }

  const hostPid = view.hostPid
  const k2 = startKeeper(data)
  const k2code = await Promise.race([k2.exited, sleep(20_000).then(() => 'still running')])
  check(k2code === 3, 'a second keeper on the same folder defers to the first (exit 3)', `exit ${k2code}`)
  const after = await status(sock)
  check(after.hostPid === hostPid && hostsFor(data).length === 1, 'still one host, the same one', JSON.stringify(hostsFor(data)))
  check(alive(k1.pid), 'the first keeper is untouched')

  app.kill()
  const gone = await waitFor(() => !alive(hostPid) && !alive(k1.pid), 15_000)
  check(gone, 'killing the attached client stops the host and the keeper', `host alive ${alive(hostPid)}, keeper alive ${alive(k1.pid)}`)
  // Stopped through its own shutdown() (sessions, store, WAL checkpoint), not killed outright
  check(
    readFileSync(join(data, 'host.log'), 'utf8').includes(`[agent-host] shutting down (pid ${hostPid}, stopped)`),
    'the host shut down through its own shutdown path',
  )
  check(!existsSync(sock), 'the socket is removed on the way out')
}

async function scenarioBackgroundOn() {
  log('\nbackground on')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const IDLE = 8
  const k = startKeeper(data, { env: { CC_KEEPER_IDLE_SECS: String(IDLE) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const info = bundleInfo()
  const build = { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC }
  const app1 = attachClient(sock, build)
  await app1.first()
  const set = await request(sock, { op: 'set_background', on: true })
  check(set.ok && set.background === true, 'background mode can be turned on')
  check(JSON.parse(readFileSync(join(data, 'keeper-settings.json'), 'utf8')).background === true, 'and is saved in the data folder')

  app1.kill()
  await sleep(3000)
  const v2 = await status(sock).catch(() => null)
  check(alive(k.pid) && alive(view.hostPid) && v2?.attached === 0, 'killing the client leaves the keeper and the host running', JSON.stringify(v2?.attached))

  const app2 = attachClient(sock, build)
  const first = await app2.first()
  check(
    first?.view?.hostPid === view.hostPid && first?.view?.status?.port === view.status.port,
    'a relaunched client re-attaches to the same host',
    `pid ${first?.view?.hostPid} vs ${view.hostPid}`,
  )

  // Another build: the same host folder with a different stamp.
  const src2 = mkdtempSync('/tmp/ck-src2-')
  tempDirs.push(src2)
  cpSync(HOST_SRC, src2, { recursive: true })
  writeFileSync(join(src2, 'bundle-info.json'), JSON.stringify({ ...info, commit: 'fakecommit2' }))
  const sw = await request(sock, { op: 'switch', source: { commit: 'fakecommit2', hostDir: src2, bundlePath: '/tmp/Other.app' } })
  check(sw.ok, 'switch is accepted')
  const switched = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v.source?.commit === 'fakecommit2' && v
  }, 30_000)
  check(switched && switched.hostPid !== view.hostPid, 'the host restarts from the other build', JSON.stringify(switched?.source))
  check(existsSync(join(data, 'hosts', 'fakecommit2', 'main.mjs')), "the other build gets its own copy")
  const oldCopy = join(data, 'hosts', keyOf(info.commit, info.builtAt))
  check(await waitFor(() => !existsSync(oldCopy), 5000), 'the copy no host uses any more is removed')
  check(!alive(view.hostPid) && hostsFor(data).length === 1, 'the old host is gone and one host remains', JSON.stringify(hostsFor(data)))
  check(
    app2.lines.some((l) => l.event === 'status' && l.view?.source?.commit === 'fakecommit2'),
    'the attached client was told about the switch',
  )

  app2.kill()
  const detachedAt = Date.now()
  const hostPid = switched?.hostPid
  const ended = await waitFor(() => !alive(k.pid) && !alive(hostPid), (IDLE + 15) * 1000, 250)
  const after = (Date.now() - detachedAt) / 1000
  check(ended && after >= IDLE - 1, `with nothing attached and nothing running, it ends itself after the idle limit (${IDLE}s)`, `ended ${!!ended} after ${after.toFixed(1)}s`)
}

async function scenarioStop() {
  log('\nquit completely')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'other', hostDir: HOST_SRC })
  const first = await app.first()
  check(first?.sameBuild === false, 'a client of another build is told so')
  await request(sock, { op: 'set_background', on: true })
  const stop = await request(sock, { op: 'stop' })
  check(stop.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(k.pid) && !alive(view.hostPid), 10_000)
  check(gone, 'stop ends the host and the keeper even with background mode on')
  app.kill()
}

async function scenarioBusyHoldsIdle() {
  log('\nan unwatched keeper with something running is not idle')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const IDLE = 3
  const k = startKeeper(data, { env: { CC_KEEPER_IDLE_SECS: String(IDLE) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock, { commit: 'x' })
  await app.first()
  await request(sock, { op: 'set_background', on: true })
  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const host = await hostClient(view.status.port, view.status.token)
  try {
    const p = await host.call('projects.add', { path: project })
    const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
    const busy = await waitFor(async () => (await status(sock)).busy, 15_000, 250)
    check(busy, 'an open terminal is reported to the keeper as activity')
    app.kill()
    await sleep((IDLE + 6) * 1000)
    check(alive(k.pid) && alive(view.hostPid), `with a terminal open it outlives the idle limit (${IDLE}s) with no window`)
    await host.call('terminal.close', { terminalId: term.terminalId })
    const ended = await waitFor(() => !alive(k.pid) && !alive(view.hostPid), (IDLE + 15) * 1000, 250)
    check(ended, 'once the terminal closes, it ends itself after the idle limit')
  } catch (e) {
    check(false, 'the host takes a project and a terminal', String(e))
  } finally {
    host.close()
  }
}

async function scenarioKeeperDies() {
  log('\nthe host is tied to the keeper, not the app')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k = startKeeper(data)
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  // The host reads the keeper's stdin pipe (--watch-parent): a keeper killed outright still takes
  // its host with it, so a crashed keeper never leaves an unowned host behind.
  process.kill(k.pid, 'SIGKILL')
  const gone = await waitFor(() => !alive(view.hostPid), 10_000)
  check(gone, 'a SIGKILLed keeper takes its host with it', `host ${view.hostPid} alive ${alive(view.hostPid)}`)
  const k2 = startKeeper(data)
  const again = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  check(again && again.keeper.pid === k2.pid, 'a new keeper takes over the folder (stale socket and all)')
  await request(sock, { op: 'stop' }).catch(() => {})
  await waitFor(() => !alive(k2.pid), 10_000)
}

export { scenarioBackgroundOff, scenarioBackgroundOn, scenarioStop, scenarioBusyHoldsIdle, scenarioKeeperDies }
