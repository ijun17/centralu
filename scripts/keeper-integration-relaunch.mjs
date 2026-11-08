/**
 * Keeper scenarios (`keeper-integration.mjs`): an update as a stop and continue, with a host crash,
 * background mode and a quit under the keeper started next (#1895). An announced relaunch ("Apply
 * now" holding the keeper, #352) went with #1895 step 4 PR 3: an update stops the keeper. The keeper
 * a Linux window started from a copy out of its AppImage (FI4, FI5) went with step 4 PR 7.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, attachHere, familyOf, hostClient, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, check, log, newData, readyView, session, startKeeper, STEPS, tempDirs, toolResults, transcript } from './keeper-integration-harness.mjs'

/** `--claude`: the update and the crash below also cut a claude (`haiku`) turn. A few cents of model use; never in CI */
const WITH_CLAUDE = process.argv.includes('--claude')
/** The line a turn an update cut and Centralu continued carries in the conversation (`UPDATE_CONTINUE_LINE`) */
const CONTINUED = 'Centralu was updated during this turn'
const stoppedMark = (data) => existsSync(join(data, 'stopped.json')) && readFileSync(join(data, 'stopped.json'), 'utf8')
const hostLog = (data) => readFileSync(join(data, 'host.log'), 'utf8')

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

export { scenarioUpdate }
