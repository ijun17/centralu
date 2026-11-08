/**
 * Keeper scenarios (`keeper-integration.mjs`): an update as a stop and continue, with a host crash,
 * background mode and a quit under the keeper started next (#1895); and a keeper started from a
 * content copy that lets go of what an AppImage handed it (FI4, FI5). An announced relaunch ("Apply
 * now" holding the keeper, #352) went with #1895 step 4 PR 3: an update stops the keeper.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, attachHere, familyOf, hostClient, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, BIN, check, HOST_SRC, hostsFor, log, newData, ready, readyView, session, startKeeper, STEPS, tempDirs, toolResults, transcript } from './keeper-integration-harness.mjs'

/** `--claude`: the update and the crash below also cut a claude (`haiku`) turn. A few cents of model use; never in CI */
const WITH_CLAUDE = process.argv.includes('--claude')
/** The line a turn an update cut and Centralu continued carries in the conversation (`UPDATE_CONTINUE_LINE`) */
const CONTINUED = 'Centralu was updated during this turn'
const stoppedMark = (data) => existsSync(join(data, 'stopped.json')) && readFileSync(join(data, 'stopped.json'), 'utf8')
const hostLog = (data) => readFileSync(join(data, 'host.log'), 'utf8')

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
 * An update is a stop and continue (#1895): `stop` with `forUpdate` stops the host, which ends its own terminal, dev server
 * and agents and lists them, and then the keeper; the keeper started next opens the terminal again, starts the dev server
 * again and (`--claude`) continues the cut turn with Centralu's note. Under that keeper a host crash ends the processes the
 * host started and reopens nothing, its turn shown stopped; background mode keeps the host and its children with no window
 * attached; and stop ends everything, noting that the person quit.
 */
async function scenarioUpdate() {
  log('\nan update: the keeper stops the host for it and exits (#1895)')
  const data = newData()
  const sock = join(data, 'keeper.sock')
  const project = mkdtempSync('/tmp/ck-proj-')
  tempDirs.push(project)
  execFileSync('git', ['init', '-q'], { cwd: project })
  const k = startKeeper(data)
  let view = await readyView(sock)
  if (!check(view, 'the keeper brings the host up')) return
  const app = attachClient(sock)
  await app.first()
  check(!existsSync(join(data, 'children.sock')), 'the keeper serves no child socket: the host spawns its own children')
  const ann = await request(sock, { op: 'relaunching' })
  check(ann.ok === false, 'it takes no announced relaunch: an update stops it instead (#1895 step 4)', JSON.stringify(ann))
  // Said by the host's line after its ready line, which the keeper reads on its own thread
  check(await waitFor(async () => (await status(sock))?.stopsForUpdate === true, 10_000, 100), 'its host says it stops for an update')

  let host = await hostClient(view.status.port, view.status.token)
  const p = await host.call('projects.add', { path: project })
  const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'echo T$((6*7))\n' })
  check(await waitFor(() => host.screen(term.terminalId).includes('T42'), 15_000), 'the terminal runs a command', host.screen(term.terminalId).slice(-300))
  const cmd = `node -e "let i=0;setInterval(()=>console.log('tick '+(i++)),300)"`
  await host.call('commands.run', { projectId: p.id, command: cmd })
  check(await waitFor(async () => (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history.includes('tick 3'), 15_000), 'the dev server prints')
  let claudeId = null
  if (WITH_CLAUDE) {
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    claudeId = s.id
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
    check(await waitFor(() => toolResults(host, claudeId) >= 1, 90_000, 250), 'a claude turn is under way (first tool result)')
  }
  const before = familyOf([view.hostPid])
  check(before.length >= 3, `the host runs its terminal and dev server itself (${before.length - 1} processes under it)`)
  host.close()
  // From a window attached now, as the shell asks: `app` is another process, and the keeper judges the one asking (#2117)
  const here = await attachHere(sock)
  const stop = await request(sock, { op: 'stop', forUpdate: true }, 40_000)
  here.destroy()
  check(stop.ok, 'stop for an update is answered once the host is gone', JSON.stringify(stop))
  check(
    await waitFor(() => !alive(k.pid) && before.every((pid) => !alive(pid)), 10_000, 250),
    'the keeper, the host and every process the host started have ended',
    before.filter(alive).join(', '),
  )
  check(/asked to stop \(the keeper, for an update\)/.test(hostLog(data)), 'the host heard it on its stdin, for an update')
  check(!stoppedMark(data), 'and left no quit mark: a linked hub may start a host here')
  app.kill()

  log('\nthe relaunched window starts a keeper, as the shell would')
  const k2 = startKeeper(data)
  view = await readyView(sock)
  if (!check(view, 'the new keeper brings the host up')) return
  const app2 = attachClient(sock)
  await app2.first()
  host = await hostClient(view.status.port, view.status.token)
  const terms = await waitFor(async () => {
    const l = (await host.call('terminal.list', { projectId: p.id })).terminals.filter((x) => x.alive)
    return l.length >= 1 && l
  }, 15_000)
  check(terms, 'the open terminal is opened again', JSON.stringify(terms))
  const again = await waitFor(async () => {
    const l = (await host.call('commands.log', { projectId: p.id, command: cmd })).run
    return l?.running && l.history.includes('Started again after the update.') && l
  }, 15_000)
  check(again, 'the dev server is started again, and says so')
  if (claudeId) {
    const continued = await waitFor(async () => {
      const tr = await transcript(host, claudeId)
      const at = tr.lastIndexOf(CONTINUED)
      return at >= 0 && /DONE/.test(tr.slice(at)) && tr
    }, 180_000, 1000)
    check(continued, 'the cut claude turn is continued, says so, and ends', (await transcript(host, claudeId)).slice(-1200))
  }

  log('\na host crash ends what it started')
  let crashId = null
  if (WITH_CLAUDE) {
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    crashId = s.id
    await host.call('agents.send', { sessionId: crashId, text: STEPS(4) })
    check(await waitFor(() => toolResults(host, crashId) >= 1, 90_000, 250), 'a claude turn is under way')
  }
  const crashed = view.hostPid
  const own = familyOf([crashed]).filter((pid) => pid !== crashed)
  host.close()
  process.kill(crashed, 'SIGKILL')
  view = await readyView(sock, crashed)
  if (!check(view, 'the keeper restarts the crashed host')) return
  check(own.length >= 1 && (await waitFor(() => own.every((pid) => !alive(pid)), 15_000, 250)), `the ${own.length} processes it had started have ended with it`, own.filter(alive).join(', '))
  host = await hostClient(view.status.port, view.status.token)
  const left = (await host.call('terminal.list', { projectId: p.id })).terminals.filter((x) => x.alive)
  check(left.length === 0, 'its terminals are not reopened: only an update lists them', JSON.stringify(left))
  if (crashId) {
    const s = await waitFor(async () => {
      const x = await session(host, crashId)
      return x && x.state !== 'working' && !x.live && x
    }, 15_000, 250)
    check(s, 'the cut turn shows stopped, to continue by hand', JSON.stringify(await session(host, crashId)))
    check(!(await transcript(host, crashId)).includes(CONTINUED), 'and is not continued by itself')
  }

  log('\nbackground mode, no window attached')
  const set = await request(sock, { op: 'set_background', on: true })
  check(set.ok && set.background === true, 'background mode is turned on')
  await host.call('commands.run', { projectId: p.id, command: cmd })
  check(await waitFor(async () => (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.running, 15_000), 'a dev server runs')
  host.close()
  app2.kill()
  await sleep(1500)
  const hostPid = view.hostPid
  const kids = familyOf([hostPid]).filter((pid) => pid !== hostPid)
  check(alive(k2.pid) && alive(hostPid) && kids.length >= 1, `the keeper, the host and its own children keep running (${kids.length} processes)`)

  log('\nquit completely')
  const pids = [hostPid, ...kids]
  const quit = await request(sock, { op: 'stop' })
  check(quit.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(k2.pid) && pids.every((pid) => !alive(pid)), 20_000, 250)
  check(gone, `stop ends the keeper, the host and its ${kids.length} children`, pids.filter(alive).map((pid) => `${pid} still alive`).join(', '))
  check(/asked to stop \(the keeper\)/.test(hostLog(data)), 'the host heard the stop on its stdin')
  check((stoppedMark(data) || '').includes('"quit"'), 'and noted that the person quit, for a linked hub (#1143)', String(stoppedMark(data)))
}

export { scenarioFromACopy, scenarioUpdate }
