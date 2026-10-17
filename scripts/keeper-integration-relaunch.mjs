/**
 * Keeper scenarios (`keeper-integration.mjs`): an announced relaunch ("Apply now", #352), and a
 * keeper started from a content copy that lets go of what an AppImage handed it (FI4, FI5).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, heldChildren, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, BIN, bundleInfo, check, HOST_SRC, hostClient, hostsFor, log, newData, ready, started, startKeeper, tempDirs } from './keeper-integration-harness.mjs'

/** Resolves once every process holding the other end of `stream` has closed it */
function released(stream) {
  return new Promise((resolve) => {
    stream.on('end', resolve)
    stream.on('close', resolve)
    stream.on('error', resolve)
    stream.resume()
  })
}

/** A process's environment: `/proc` on Linux, `ps -E` (own processes only) on macOS */
function environOf(pid) {
  if (existsSync(`/proc/${pid}/environ`)) return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  return execFileSync('ps', ['-wwE', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).split(/\s+/)
}

/**
 * FI4 and FI5 (docs/spikes/2026-10-linux-keeper.md §6): a keeper the window started from its copy in
 * `<data>/content/<version>/` lets go of what the AppImage's runtime handed it, so the mount can go
 * when the window quits, and its host and children see nothing of the AppImage's environment. A
 * keeper started any other way keeps them: they are what keeps its code mounted.
 */
async function scenarioFromACopy() {
  log('\nthe keeper from a copy lets the AppImage go (FI4, FI5)')
  const mount = mkdtempSync('/tmp/ck-mount-')
  tempDirs.push(mount)
  const appEnv = {
    APPDIR: mount,
    APPIMAGE: `${mount}.AppImage`,
    XDG_DATA_DIRS: `${mount}/usr/share:/usr/share`,
    GTK_PATH: `${mount}/usr/lib/gtk-3.0`,
  }
  const pipes = ['pipe', 'pipe']

  // Started any other way (here: from the build folder): the descriptors stay held
  const direct = newData()
  const dk = startKeeper(direct, { env: appEnv, extra: pipes })
  const dHeld = [released(dk.stdio[3]), released(dk.stdio[4])]
  const dView = await waitFor(async () => {
    const v = await status(join(direct, 'keeper.sock'))
    return ready(v) && v
  }, 30_000)
  if (!check(dView, 'a keeper started outside content brings the host up')) return
  const dLet = await Promise.race([Promise.all(dHeld).then(() => true), sleep(2000).then(() => false)])
  check(!dLet, 'it and its host keep what the window handed them (what keeps its own code mounted)')
  await request(join(direct, 'keeper.sock'), { op: 'stop' }).catch(() => {})

  // From the window's copy
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const dir = join(data, 'content', '0.0.0-test')
  mkdirSync(dir, { recursive: true })
  cpSync(BIN, join(dir, 'centralu-keeper'))
  cpSync(HOST_SRC, join(dir, 'host'), { recursive: true })
  const k = startKeeper(data, { bin: join(dir, 'centralu-keeper'), hostSource: join(dir, 'host'), env: appEnv, extra: pipes })
  const held = Promise.all([released(k.stdio[3]), released(k.stdio[4])])
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper from the copy brings the host up')) return
  const host = hostsFor(data)[0]
  check(host?.command.includes(`${dir}/host/main.mjs`), 'the host runs from the copy as it is, not from hosts/', host?.command)
  const let_ = await Promise.race([held.then(() => true), sleep(10_000).then(() => false)])
  check(let_, 'neither the keeper nor its host holds what the window handed them, so the mount can go')
  const env = environOf(view.hostPid)
  const leaked = env.filter((e) => e.includes(mount) || /^(APPDIR|APPIMAGE)=/.test(e))
  check(leaked.length === 0, "the host's environment names nothing of the AppImage", leaked.join(' '))
  check(env.includes('XDG_DATA_DIRS=/usr/share'), 'and keeps the rest of a list it was in', env.filter((e) => e.startsWith('XDG')).join(' '))
  await request(sock, { op: 'stop' }).catch(() => {})
}

/**
 * "Apply now" (#352): the app announces a relaunch, its window closes, and the relaunched window
 * attaches within the grace. With background mode off, nothing may stop in between; without the
 * announcement, or once the grace has run out, the keeper stops as it always did.
 */
async function scenarioRelaunch() {
  log('\nan announced relaunch with background mode off (#352)')
  const GRACE = 6
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const k = startKeeper(data, { env: { CC_KEEPER_RELAUNCH_SECS: String(GRACE) } })
  const view = await waitFor(async () => {
    const v = await status(sock)
    return ready(v) && v
  }, 30_000)
  if (!check(view, 'the keeper brings the host up')) return
  check(view.background === false, 'background mode is off')
  const info = bundleInfo()
  const build = { commit: info.commit, builtAt: info.builtAt, hostDir: HOST_SRC }
  const app1 = attachClient(sock, build)
  const first1 = await app1.first()
  check(first1?.ok === true && first1.relaunched === false, 'a window opened by hand is not told it was relaunched', JSON.stringify(first1?.relaunched))

  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  const host = await hostClient(view.status.port, view.status.token)
  let shell
  let term
  try {
    const p = await host.call('projects.add', { path: project })
    term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
    const held = await waitFor(async () => (await heldChildren(data)).find((c) => c.tag?.kind === 'terminal' && c.tag.id === term.terminalId), 10_000)
    shell = held?.pid
    check(alive(shell), 'the keeper holds the terminal', JSON.stringify(held))
    if (shell) started.add(shell)
  } catch (e) {
    check(false, 'the host takes a project and a terminal', String(e))
  } finally {
    host.close()
  }

  const ann = await request(sock, { op: 'relaunching' })
  check(ann.ok === true && ann.graceSecs === GRACE, `the keeper takes the announcement (grace ${GRACE}s)`, JSON.stringify(ann))
  app1.kill()
  await sleep(2500)
  const mid = await status(sock).catch(() => null)
  check(
    alive(k.pid) && alive(view.hostPid) && alive(shell) && mid?.attached === 0,
    'the window closing for the relaunch stops nothing: keeper, host and terminal run on with no window',
    `keeper ${alive(k.pid)}, host ${alive(view.hostPid)}, terminal ${alive(shell)}, attached ${mid?.attached}`,
  )

  const app2 = attachClient(sock, build)
  const first2 = await app2.first()
  check(first2?.ok === true && first2.relaunched === true, 'the window that comes back is told it is the relaunched one', JSON.stringify(first2?.relaunched))
  check(first2?.view?.hostPid === view.hostPid, 'and finds the same host', `${first2?.view?.hostPid} vs ${view.hostPid}`)
  const host2 = await hostClient(view.status.port, view.status.token)
  try {
    const list = await host2.call('terminal.list', { projectId: (await host2.call('projects.list', {}))[0]?.id })
    const t = list.terminals.find((x) => x.terminalId === term?.terminalId)
    check(t?.alive === true && alive(shell), 'and the same terminal, still alive', JSON.stringify(list))
  } catch (e) {
    check(false, 'the host lists the terminal after the relaunch', String(e))
  } finally {
    host2.close()
  }

  // The grace was spent by that attach: a window closing now is the last window leaving, as always
  app2.kill()
  const stopped = await waitFor(() => !alive(k.pid) && !alive(view.hostPid), 15_000)
  check(stopped, 'without an announcement, the last window closing stops the keeper and the host as before', `keeper ${alive(k.pid)}, host ${alive(view.hostPid)}`)
  check(await waitFor(() => !alive(shell), 10_000), 'and the terminal with them')

  log('\na relaunch nobody comes back from')
  const data2 = newData()
  const sock2 = join(data2, 'keeper.sock')
  const k2 = startKeeper(data2, { env: { CC_KEEPER_RELAUNCH_SECS: String(GRACE) } })
  const view2 = await waitFor(async () => {
    const v = await status(sock2)
    return ready(v) && v
  }, 30_000)
  if (!check(view2, 'the keeper brings the host up')) return
  const app3 = attachClient(sock2, build)
  await app3.first()
  await request(sock2, { op: 'relaunching' })
  app3.kill()
  const closedAt = Date.now()
  const ended = await waitFor(() => !alive(k2.pid) && !alive(view2.hostPid), (GRACE + 15) * 1000, 250)
  const after = (Date.now() - closedAt) / 1000
  check(
    ended && after >= GRACE - 1,
    `once the grace (${GRACE}s) runs out with no window back, it stops as if nothing had been announced`,
    `ended ${!!ended} after ${after.toFixed(1)}s`,
  )
  check(
    readFileSync(join(data2, 'keeper.log'), 'utf8').includes('no window came back within the relaunch grace'),
    'and says why in keeper.log',
  )
}

export { scenarioFromACopy, scenarioRelaunch }
