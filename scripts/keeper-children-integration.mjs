#!/usr/bin/env node
/**
 * The keeper's child service (#280, option C step 2) and the move away from it (#1895 step 3), end to end with the real
 * binary, the real host and, unless left out, a real claude.
 *
 *   node scripts/keeper-children-integration.mjs [--no-build] [--no-claude]
 *
 * Builds like `keeper-integration.mjs` (cargo build into a target folder under /tmp, never
 * `tauri build`; `pnpm bundle:host`) and runs `centralu-keeper --keeper` against a temporary
 * `CC_DATA_DIR`, with a scratch git folder under /tmp as the project. The model is the cheap one,
 * claude `haiku`. It costs a few cents of model use.
 *
 * The keeper starts as a person's keeper of an earlier build runs: it holds what its host spawns
 * (`CC_KEEPER_HOLDS_CHILDREN=1`, the switch #1895 step 3 turned off). A switch from a window of this build then hands it over to
 * a keeper of this build, which keeps serving what it was handed, and "Apply now" stops that keeper for an update.
 *
 * Checked:
 *   - while the keeper holds them, a claude turn in progress survives the host being SIGKILLed: the new host
 *     re-attaches, and the rest of the turn and its result land in the store; a terminal survives the same crash with
 *     its id and screen, and is resized after it; a dev server keeps running under the same run id, its log growing;
 *   - with background mode on and no window attached, the keeper keeps the host and what it holds running;
 *   - the transition: the keeper hands itself over to a keeper of this build with what it holds, and the swapped host
 *     takes it over, so the terminal, the dev server and a claude turn go on, uncut;
 *   - an update is a stop and continue: `stop` with `forUpdate` stops the host (which lists what it ends) and the keeper,
 *     and every child it held ends; the keeper started next serves no child socket, opens the terminals again, starts the
 *     dev server again and continues the cut claude turn with Centralu's note;
 *   - a host crash under that keeper ends the processes it started, and its turn shows stopped (no note, no reopening);
 *   - with background mode on and no window attached, the host keeps its own children running;
 *   - stop ("Quit completely") ends the keeper, the host and its children, and the host notes that the person quit.
 *
 * `--no-claude` leaves the parts that need no model and no network. CI runs exactly that (the `keeper` job in
 * `.github/workflows/build.yml`); the claude parts stay a manual run.
 *
 * Every process it starts, and everything those start, is killed before it exits, pass or fail
 * (`keeper-test-processes.mjs`); a failed run prints the end of the keeper's and the host's logs.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alive, cleanupOnExit, familyOf, heldChildren, hostClient, killFamily, once, printLogTails, request, sleep, status, waitFor } from './keeper-test-processes.mjs'
import { attachClient, BIN, buildKeeper, HOST_SRC, log, readyView, recordedOnce, session, startKeeper, started, STEPS, tempDirs, toolResults, transcript } from './keeper-integration-harness.mjs'

// The clients here are this Node process, not a Centralu window: a debug keeper started with this also accepts its
// executable as a window's, so they get the token and may switch and upgrade (#1405, keeper/window_peer.rs). A release
// keeper ignores it.
process.env.CC_KEEPER_TEST_WINDOW_EXE = process.execPath

const WITH_CLAUDE = !process.argv.includes('--no-claude')
const heldPids = new Set()
let failures = 0

function check(cond, what, detail = '') {
  if (cond) log(`  ok   ${what}`)
  else {
    failures++
    log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`)
  }
  return cond
}

async function scenario() {
  const data = mkdtempSync('/tmp/ckc-')
  tempDirs.push(data)
  const project = mkdtempSync('/tmp/ckc-proj-')
  tempDirs.push(project)
  execFileSync('git', ['init', '-q'], { cwd: project })
  const sock = join(data, 'keeper.sock')
  // A keeper of an earlier build: its hosts hand their children to it
  const keeper = startKeeper(data, { env: { CC_KEEPER_HOLDS_CHILDREN: '1' } })
  let view = await readyView(sock)
  if (!check(view, 'the keeper brings the host up', existsSync(join(data, 'keeper.log')) ? readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2000) : '')) return
  const app = attachClient(sock)
  await sleep(500)
  await request(sock, { op: 'set_background', on: true })
  check(existsSync(join(data, 'children.sock')), 'the keeper serves its child socket')

  let host = await hostClient(view.status.port, view.status.token)
  const p = await host.call('projects.add', { path: project })

  // A terminal, with something on its screen
  log('\na terminal and a dev server')
  const term = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'echo T$((6*7))\n' })
  check(await waitFor(() => host.screen(term.terminalId).includes('T42'), 15_000), 'the terminal runs a command', host.screen(term.terminalId).slice(-300))

  // A dev server
  const cmd = `node -e "let i=0;setInterval(()=>console.log('tick '+(i++)),300)"`
  const run = await host.call('commands.run', { projectId: p.id, command: cmd })
  check(await waitFor(async () => (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history.includes('tick 3'), 15_000), 'the dev server prints')

  let held = await heldChildren(data)
  check(
    held.some((c) => c.tag?.kind === 'terminal' && c.tag.id === term.terminalId) && held.some((c) => c.tag?.kind === 'command' && c.tag.runId === run.runId),
    'the keeper, not the host, holds the terminal and the dev server',
    JSON.stringify(held.map((c) => c.tag)),
  )
  for (const c of held) heldPids.add(c.pid)

  // A claude turn in progress
  let claudeId = null
  if (WITH_CLAUDE) {
    log('\na claude turn across a host crash')
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    claudeId = s.id
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
    const firstResult = await waitFor(() => toolResults(host, claudeId) >= 1, 90_000, 250)
    check(firstResult, 'the claude turn is under way (first tool result)')
    held = await heldChildren(data)
    const claudeChild = held.find((c) => c.tag?.kind === 'agent' && c.tag.sessionId === claudeId)
    check(claudeChild?.alive, 'the keeper holds the claude process', JSON.stringify(held.map((c) => c.tag)))
    if (claudeChild) heldPids.add(claudeChild.pid)
  }

  // Crash: the host is SIGKILLed mid-turn
  const oldHost = view.hostPid
  host.close()
  process.kill(oldHost, 'SIGKILL')
  view = await readyView(sock, oldHost)
  if (!check(view, 'the keeper restarts a crashed host')) return
  host = await hostClient(view.status.port, view.status.token)

  if (claudeId) {
    const back = await waitFor(async () => (await session(host, claudeId))?.live && (await session(host, claudeId)), 30_000)
    check(back, 'the new host re-attached the claude session as live', JSON.stringify(await session(host, claudeId).catch(() => null)))
    const done = await waitFor(async () => {
      const t = await transcript(host, claudeId)
      return t.includes('step4') && /DONE/.test(t) && t
    }, 120_000, 1000)
    check(done, 'the rest of the claude turn and its result arrive through the new host', (await transcript(host, claudeId)).slice(-800))
    const once = await recordedOnce(host, claudeId)
    check(once.ok, 'every tool call and result of that turn is recorded exactly once', JSON.stringify(once))
    const settled = await waitFor(async () => {
      const s = await session(host, claudeId)
      return s && s.state !== 'working' && s
    }, 30_000, 500)
    check(settled, 'the session settles once the turn ends', (await session(host, claudeId))?.state)
  }

  log('\nthe terminal and the dev server after the crash')
  const terms = await host.call('terminal.list', { projectId: p.id })
  const t2 = terms.terminals.find((t) => t.terminalId === term.terminalId)
  check(t2?.alive, 'the terminal is still there under its id', JSON.stringify(terms))
  check(t2?.history?.includes('T42') ?? false, 'its screen came back from the keeper', (t2?.history ?? '').slice(-300))
  await host.call('terminal.resize', { terminalId: term.terminalId, cols: 132, rows: 50 })
  await sleep(300)
  await host.call('terminal.input', { terminalId: term.terminalId, data: 'stty size\n' })
  check(await waitFor(() => host.screen(term.terminalId).includes('50 132'), 10_000), 'and is resized after the restart', host.screen(term.terminalId).slice(-300))
  const runs = (await host.call('commands.state', { projectId: p.id })).runs
  const r2 = runs.find((r) => r.command === cmd)
  check(r2?.running && r2.runId === run.runId, 'the dev server is still running under the same run id', JSON.stringify(runs))
  const logA = (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history ?? ''
  await sleep(1200)
  const logB = (await host.call('commands.log', { projectId: p.id, command: cmd })).run?.history ?? ''
  check(logB.length > logA.length && /tick \d+/.test(logB), 'and its log keeps growing')

  await transition({ data, sock, project, p, keeper, app, view, host, term, run, cmd })
}

/** A keeper of this build: its own copy of the keeper executable and of the bundled host, stamped `commit` (as the handoff script makes builds) */
function buildOf(commit) {
  const dir = mkdtempSync('/tmp/ckc-build-')
  tempDirs.push(dir)
  const host = join(dir, 'host')
  cpSync(HOST_SRC, host, { recursive: true })
  const info = JSON.parse(readFileSync(join(HOST_SRC, 'bundle-info.json'), 'utf8'))
  writeFileSync(join(host, 'bundle-info.json'), JSON.stringify({ ...info, commit, builtAt: new Date().toISOString() }))
  const keeper = join(dir, 'centralu-keeper')
  cpSync(BIN, keeper)
  return { host, keeper, commit, bundle: join(dir, 'Centralu.app') }
}

const liveTags = async (data) => (await heldChildren(data)).filter((c) => c.alive).map((c) => c.tag)
/** The line a turn an update cut and Centralu continued carries in the conversation (`UPDATE_CONTINUE_LINE`) */
const CONTINUED = 'Centralu was updated during this turn'
const stoppedMark = (data) => existsSync(join(data, 'stopped.json')) && readFileSync(join(data, 'stopped.json'), 'utf8')

/** #1895 step 3: from a keeper that holds its host's children to keepers that hold none */
async function transition({ data, sock, project, p, keeper, app, view, host, term, run, cmd }) {
  log('\nbackground mode, no window attached, the keeper holding the children')
  host.close()
  app.kill()
  await sleep(1500)
  check(alive(view.hostPid) && (await liveTags(data)).length >= 2, 'the host and the children the keeper holds keep running', JSON.stringify(await liveTags(data)))

  log('\nthe transition: a window of this build switches the holding keeper over')
  const app2 = attachClient(sock)
  await sleep(500)
  check((await status(sock))?.keepsAgents === true, 'the earlier host says it hands its agents over')
  let claudeId = null
  if (WITH_CLAUDE) {
    host = await hostClient(view.status.port, view.status.token)
    const s = await host.call('agents.createSession', { projectId: p.id, cwd: project, tool: 'claude', model: 'haiku', permissionPreset: 'auto' })
    claudeId = s.id
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
    check(await waitFor(() => toolResults(host, claudeId) >= 1, 90_000, 250), 'a claude turn is under way on the earlier host')
    const c = (await heldChildren(data)).find((c) => c.tag?.kind === 'agent' && c.tag.sessionId === claudeId)
    check(c?.alive, 'the keeper holds its process')
    if (c) heldPids.add(c.pid)
    host.close()
  }
  // What a window of this build sends to a keeper that does not stop for an update: its keeper executable, so the keeper hands
  // itself over (with what it holds) and then swaps the host
  const b = buildOf('transition-b')
  const sw = await request(sock, { op: 'switch', source: { commit: b.commit, hostDir: b.host, bundlePath: b.bundle, version: '0.0.0-test' }, keeper: { exe: b.keeper } })
  check(sw.ok, 'the switch is accepted', JSON.stringify(sw))
  view = await waitFor(async () => {
    const v = await status(sock)
    return v?.keeper?.build?.commit === b.commit && v?.source?.commit === b.commit && v?.status?.state === 'ready' && v?.swap?.phase === 'done' && v
  }, 90_000, 250)
  if (!check(view, 'the keeper and the host both end on this build', readFileSync(join(data, 'keeper.log'), 'utf8').slice(-2500))) return
  check(view.stopsForUpdate === true, 'the keeper of this build stops for an update')
  check(await waitFor(() => !alive(keeper.pid), 10_000), 'the earlier keeper has exited')
  const took = readFileSync(join(data, 'host.log'), 'utf8').match(/taking over \d+ kept: \d+ agents, \d+ terminals, \d+ command runs/g)?.at(-1) ?? ''
  check(/, 1 terminals, 1 command runs/.test(took) && (!claudeId || !/ 0 agents/.test(took)), 'the new host takes over what the earlier keeper held', took)
  host = await hostClient(view.status.port, view.status.token)
  const t = (await host.call('terminal.list', { projectId: p.id })).terminals.find((x) => x.terminalId === term.terminalId)
  check(t?.alive && (t.history ?? '').includes('T42'), 'the terminal goes on under its id, with its screen', JSON.stringify(t ?? null).slice(0, 300))
  const r = (await host.call('commands.state', { projectId: p.id })).runs.find((x) => x.command === cmd)
  check(r?.running && r.runId === run.runId, 'the dev server goes on under the same run id', JSON.stringify(r ?? null))
  if (claudeId) {
    const done = await waitFor(async () => {
      const tr = await transcript(host, claudeId)
      return tr.includes('step4') && /DONE/.test(tr) && tr
    }, 150_000, 1000)
    check(done, 'the claude turn goes on to its end through the new host, not cut', (await transcript(host, claudeId)).slice(-800))
  }
  const term2 = await host.call('terminal.create', { projectId: p.id, cols: 80, rows: 24 })
  await sleep(1500)
  await host.call('terminal.input', { terminalId: term2.terminalId, data: 'echo U$((6*7))\n' })
  check(await waitFor(() => host.screen(term2.terminalId).includes('U42'), 15_000), 'a terminal opened now runs a command', host.screen(term2.terminalId).slice(-300))

  log('\nan update: the keeper stops the host for it and exits')
  if (claudeId) {
    const seen = toolResults(host, claudeId)
    await host.call('agents.send', { sessionId: claudeId, text: STEPS(4) })
    check(await waitFor(() => toolResults(host, claudeId) > seen, 90_000, 250), 'a second claude turn is under way')
  }
  const pidsBefore = [view.hostPid, ...(await heldChildren(data)).filter((c) => c.alive).map((c) => c.pid)]
  const keeperB = view.keeper.pid
  started.add(keeperB)
  host.close()
  const stop = await request(sock, { op: 'stop', forUpdate: true }, 40_000)
  check(stop.ok, 'stop for an update is answered once the host is gone', JSON.stringify(stop))
  check(await waitFor(() => !alive(keeperB) && pidsBefore.every((pid) => !alive(pid)), 10_000, 250), 'the keeper, the host and every child it held have ended', pidsBefore.filter(alive).join(', '))
  check(/asked to stop \(the keeper, for an update\)/.test(readFileSync(join(data, 'host.log'), 'utf8')), 'the host heard it on its stdin, for an update')
  check(!stoppedMark(data), 'and left no quit mark: a linked hub may start a host here')
  app2.kill()

  log('\nthe relaunched window starts a keeper of this build, as the shell would')
  const keeperC = startKeeper(data, { hostSource: b.host, env: { CC_KEEPER_HOLDS_CHILDREN: '' } })
  view = await readyView(sock)
  if (!check(view, 'the new keeper brings the host up')) return
  const app3 = attachClient(sock)
  check(!existsSync(join(data, 'children.sock')), 'it serves no child socket')
  const hostLog = readFileSync(join(data, 'host.log'), 'utf8')
  check(hostLog.lastIndexOf('[keeper] no child service') > hostLog.lastIndexOf('[keeper] child service connected'), 'and the host spawns its own children')
  host = await hostClient(view.status.port, view.status.token)
  const terms = await waitFor(async () => {
    const l = (await host.call('terminal.list', { projectId: p.id })).terminals.filter((x) => x.alive)
    return l.length >= 2 && l
  }, 15_000)
  check(terms, 'both open terminals are opened again', JSON.stringify(terms))
  const again = await waitFor(async () => {
    const l = (await host.call('commands.log', { projectId: p.id, command: cmd })).run
    return l?.running && l.history.includes('Started again after the update.') && l
  }, 15_000)
  check(again, 'the dev server is started again')
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
  check(await waitFor(() => own.every((pid) => !alive(pid)), 15_000, 250), `the ${own.length} processes it had started have ended with it`, own.filter(alive).join(', '))
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

  log('\nbackground mode, no window attached, the host owning its children')
  await host.call('commands.run', { projectId: p.id, command: cmd })
  host.close()
  app3.kill()
  await sleep(1500)
  const hostPid = view.hostPid
  const kids = familyOf([hostPid]).filter((pid) => pid !== hostPid)
  check(alive(hostPid) && kids.length >= 1, `the host and its own children keep running (${kids.length} processes)`)

  log('\nquit completely')
  const pids = [hostPid, ...kids]
  const quit = await request(sock, { op: 'stop' })
  check(quit.ok, 'stop is accepted')
  const gone = await waitFor(() => !alive(keeperC.pid) && pids.every((pid) => !alive(pid)), 20_000, 250)
  check(gone, `stop ends the keeper, the host and its ${kids.length} children`, pids.filter(alive).map((pid) => `${pid} still alive`).join(', '))
  check(/asked to stop \(the keeper\)/.test(readFileSync(join(data, 'host.log'), 'utf8')), 'the host heard the stop on its stdin')
  check(stoppedMark(data)?.includes('"quit"'), 'and noted that the person quit, for a linked hub (#1143)', String(stoppedMark(data)))
}

const cleanup = once((threw) => {
  if (failures > 0 || threw) printLogTails(tempDirs, log)
  killFamily([...started, ...heldPids])
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

async function main() {
  if (!process.argv.includes('--no-build')) {
    buildKeeper()
  }
  if (!existsSync(BIN)) throw new Error(`no binary at ${BIN}`)
  await scenario()
}

cleanupOnExit(cleanup, log)
try {
  await main()
} catch (e) {
  failures++
  log(`\nerror: ${e?.stack ?? e}`)
} finally {
  cleanup()
}
log(failures === 0 ? '\nall keeper child checks passed' : `\n${failures} keeper child check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
