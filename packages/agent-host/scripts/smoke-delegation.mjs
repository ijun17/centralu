/**
 * What one session can reach in another, end to end on a real host with real models. One case per run, each on a host
 * of its own on a temp folder (`CC_DATA_DIR` inside it, never `~/.centralu`):
 *
 *   start-agent  #561: does a session start another agent in its own project, and read back the file it made?
 *                A Claude haiku session (preset normal) in one trusted scratch project is told to have another agent write
 *                a file with a number only that agent knows, then read it. The script plays the person: it allows any
 *                approval the child raises. The parent raises no start_agent card: in a trusted project a `normal`
 *                session's start needs none (#673); one would be allowed too, and fail the check.
 *                CHILD=codex (default: gpt-5.6-luna, low effort, the project's remembered choice) or CHILD=claude (haiku);
 *                WORKTREE=1 makes the project a git repository and has the child work in a new worktree (#561 part 2).
 *                Passes when no agent_start card stood in the parent; a child opened in the same project marked `askedBy`
 *                the parent, on the tool asked for, with the parent's preset; the file exists; and the parent's final
 *                answer carries the number that is in the file.
 *   ask-project  #371 part B: does a session in one project ask another project, and read back the file it made?
 *                A Claude haiku session in "consumer" (preset safe, so a read outside its folder would raise a card) is
 *                told to have "toolkit" write the file. The script answers the consent card "always", and allows any
 *                approval the delegated session raises. CALLEE=claude (default, haiku) or CALLEE=codex (gpt-5.6-luna, low
 *                effort) picks toolkit's agent; CALLER the same for consumer's (Codex reaches ask_project through the
 *                bridge, and does not restrict reads, so the read-grant check is Claude's only).
 *                Passes when the consent card stood in the caller with the project_access detail; the existing toolkit
 *                session received the task with caller provenance; the file exists; the caller's final answer carries the
 *                number that is in the file; and the caller's read of that file raised no card (the read grant).
 *   app-access   #371 part A: does a session find a shared app in another project, use one of its tools, detach it, and is
 *                the tool then gone? The unit tests pin the rules (sharing, consent per pair, attach and detach for
 *                Claude and Codex); whether a model, asked in plain words, finds the deferred find_apps through tool
 *                search, attaches the app, calls its tool in the same turn, and detaches it can only be known here. The
 *                second scratch project has a project app (the runtime's test fixture in its `attach` mode: `peek` reads
 *                a number, `poke` sets it), shared by the person; the consent card is answered "always".
 *                TRIALS=5 repeats the asking turn in fresh sessions, to count how often the model finds the tools.
 *   reader       #320: does an ordinary session reach for its reader set, and does the project boundary hold? Three haiku
 *                turns seed two projects; the fourth asks about its project. Passes when it calls read_session and recall,
 *                finds the sibling's decision, and gets nothing from the other project.
 *
 * TOOL=codex runs the asking session of app-access and reader on Codex (through the bridge). Its thread keeps the servers
 * it started with, so the app's tools arrive the turn after attach_app, and app-access says "Go on." once, as the person would.
 *
 * Run with: node packages/agent-host/scripts/smoke-delegation.mjs <start-agent|ask-project|app-access|reader>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHost } from './host-client.mjs'

const TOOL = process.env.TOOL ?? 'claude'
const logger = (tag) => (...a) => console.log(`[${tag}]`, ...a)

/** A new scratch folder with the host's data folder in it */
function scratch(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  mkdirSync(join(root, 'data'))
  return root
}
/** A host on the scratch folder: its store is a file there with `db`, in memory without */
const open = (root, onEvent, db = false) => openHost({ ...(db ? { db: join(root, 'store.db') } : {}), env: { CC_DATA_DIR: join(root, 'data') }, onEvent })
const finish = (c, root) => {
  c.ws.close()
  c.host.kill()
  rmSync(root, { recursive: true, force: true })
}
const verdict = (checks) => {
  for (const [what, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
  return checks.every(([, ok]) => ok)
}
const said = (evs) => evs.filter((e) => e.type === 'message_delta').map((e) => String(e.text)).join('')
const numberIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : null)
const withNumber = (answer, number) => !!number && answer.includes(number.replace(/\D/g, '').slice(0, 6))
const settings = (tool) => (tool === 'codex' ? { model: 'gpt-5.6-luna', effort: 'low' } : { model: 'haiku' })

async function startAgent() {
  const CHILD = process.env.CHILD ?? 'codex'
  const WORKTREE = process.env.WORKTREE === '1'
  const log = logger('start')
  const root = scratch('cc-start-')
  const website = join(root, 'website')
  mkdirSync(website)
  let parentId = ''
  let child = null
  const cards = []
  const c = await open(
    root,
    (e) => {
      if (e.type === 'session_created' && e.session?.askedBy) {
        child = e.session
        log('child opened:', e.session.name, `(${e.session.tool}, ${e.session.model ?? 'default model'}, ${e.session.permissionPreset})`)
      }
      if (e.type === 'approval_request') {
        cards.push({ sessionId: e.sessionId, detail: e.detail })
        log(`card in ${e.sessionId === parentId ? 'parent' : e.sessionId === child?.id ? 'child' : e.sessionId}: ${e.detail.kind} → allow`)
        void c.call('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision: 'allow' }).catch((err) => log('answer failed:', err.message))
      }
      if (e.type === 'tool_call' && e.sessionId === parentId) log('parent tool:', e.summary.tool, '·', String(e.summary.title).slice(0, 100))
    },
    true,
  )
  if (WORKTREE) {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: website })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(website, 'README.md'), 'scratch\n')
    git('add', '.')
    git('commit', '-qm', 'init')
  }
  const project = await c.call('projects.add', { path: website })
  await c.call('projects.setTrusted', { projectId: project.id, trusted: true })
  // The project's own choice for the child's tool, as a person who used it would have left it (the child takes it)
  const seed = await c.call('agents.createSession', { projectId: project.id, cwd: website, tool: CHILD, permissionPreset: 'normal' })
  await c.call('agents.updateSettings', { sessionId: seed.id, ...settings(CHILD) })
  const parent = await c.call('agents.createSession', { projectId: project.id, cwd: website, tool: 'claude', model: 'haiku', permissionPreset: 'normal' })
  parentId = parent.id
  log('parent:', parentId, '· child tool:', CHILD)

  const mark = c.events.length
  await c.call('agents.send', {
    sessionId: parentId,
    text:
      `Use start_agent to have ${CHILD === 'codex' ? 'Codex' : 'Claude'} (tool "${CHILD}") write a file out/secret.txt${WORKTREE ? ' in a new worktree (worktree: true)' : ' in this folder'} containing a random 6-digit number of its own choosing. ` +
      'Tell it not to put the number in its answer, only the absolute path of the file. Then read that file yourself and tell me the number.',
  })
  const ended = await c.next((e) => e.sessionId === parentId && (e.type === 'turn_complete' || e.type === 'error'), 'parent turn end', 600_000, mark).then(() => true, () => false)
  const mine = c.events.slice(mark).filter((e) => e.sessionId === parentId)
  const answer = said(mine)
  const result = mine.find((e) => e.type === 'tool_result' && /answered|working|did not/.test(String(e.summary)))
  const number = numberIn(join(WORKTREE && child?.worktree ? child.worktree.path : website, 'out', 'secret.txt'))
  const consent = cards.find((x) => x.sessionId === parentId && x.detail.kind === 'agent_start')

  console.log('\n── start_agent result (as the model read it) ──\n' + String(result?.summary ?? '(none)').slice(0, 400))
  console.log('\n── parent answer ──\n' + answer.trim().slice(0, 600) + '\n')
  const ok = verdict([
    ['the parent turn ended', ended],
    ["no agent_start card stood in the parent: the project's trust is the consent (#673)", !consent],
    ['a child opened in the same project, marked askedBy the parent', !!child && child.askedBy === parentId && child.projectId === project.id],
    [`the child runs ${CHILD} under the parent's preset`, !!child && child.tool === CHILD && child.permissionPreset === 'normal'],
    ...(WORKTREE ? [['the child works in a new worktree, not the project folder', !!child?.worktree && child.worktree.path !== website]] : []),
    ['the child wrote out/secret.txt', !!number],
    ['the parent answered with the number in the file', withNumber(answer, number)],
  ])
  finish(c, root)
  return ok
}

async function askProject() {
  const CALLEE = process.env.CALLEE ?? 'claude'
  const CALLER = process.env.CALLER ?? 'claude'
  const log = logger('ask')
  const root = scratch('cc-ask-')
  const consumer = join(root, 'consumer')
  const toolkit = join(root, 'toolkit')
  for (const d of [consumer, toolkit]) mkdirSync(d)
  let callerId = ''
  let delegatedId = ''
  const cards = []
  const c = await open(
    root,
    (e) => {
      if (e.type === 'approval_request') {
        cards.push({ sessionId: e.sessionId, detail: e.detail })
        // The person: "always" for the pair, and allow whatever the delegated session asks
        const decision = e.detail.kind === 'project_access' ? 'always' : 'allow'
        log(`card in ${e.sessionId === callerId ? 'caller' : e.sessionId === delegatedId ? 'delegated' : e.sessionId}: ${e.detail.kind} → ${decision}`)
        void c.call('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision }).catch((err) => log('answer failed:', err.message))
      }
      if (e.type === 'tool_call' && e.sessionId === callerId) log('caller tool:', e.summary.tool, '·', String(e.summary.title).slice(0, 100))
    },
    true,
  )
  const pc = await c.call('projects.add', { path: consumer })
  const pt = await c.call('projects.add', { path: toolkit })
  // The script plays the person: trust the scratch projects and open the session that receives the task.
  await c.call('projects.setTrusted', { projectId: pc.id, trusted: true })
  await c.call('projects.setTrusted', { projectId: pt.id, trusted: true })
  const seed = await c.call('agents.createSession', { projectId: pt.id, cwd: toolkit, tool: CALLEE, permissionPreset: 'normal' })
  await c.call('agents.updateSettings', { sessionId: seed.id, ...settings(CALLEE) })
  const caller = await c.call('agents.createSession', { projectId: pc.id, cwd: consumer, tool: CALLER, ...settings(CALLER), permissionPreset: 'safe' })
  callerId = caller.id
  delegatedId = seed.id
  log('caller:', callerId, '· caller tool:', CALLER, '· callee tool:', CALLEE)

  const mark = c.events.length
  await c.call('agents.send', {
    sessionId: callerId,
    text:
      'Use ask_project to have the project "toolkit" write a file out/secret.txt in its folder containing a random 6-digit number of its own choosing. ' +
      'Tell it not to put the number in its answer, only the absolute path of the file. Then read that file yourself and tell me the number.',
  })
  const ended = await c.next((e) => e.sessionId === callerId && (e.type === 'turn_complete' || e.type === 'error'), 'caller turn end', 600_000, mark).then(() => true, () => false)
  const mine = c.events.slice(mark)
  const answer = said(mine.filter((e) => e.sessionId === callerId))
  const result = mine.find((e) => e.sessionId === callerId && e.type === 'tool_result' && /answered|still working|did not/.test(String(e.summary)))
  const number = numberIn(join(toolkit, 'out', 'secret.txt'))
  const consent = cards.find((x) => x.sessionId === callerId && x.detail.kind === 'project_access')
  const callerReadCards = cards.filter((x) => x.sessionId === callerId && x.detail.kind !== 'project_access')

  console.log('\n── ask_project result (as the model read it) ──\n' + String(result?.summary ?? '(none)').slice(0, 400))
  console.log('\n── caller answer ──\n' + answer.trim().slice(0, 600) + '\n')
  const ok = verdict([
    ['the caller turn ended', ended],
    ['consent card stood in the caller (project_access, delegate)', !!consent && consent.detail.access === 'delegate'],
    ['the consent names the existing session', consent?.detail.session?.id === delegatedId],
    ['the existing toolkit session received a task from the caller', mine.some((e) => e.type === 'user_message' && e.sessionId === delegatedId && e.from?.sessionId === callerId)],
    ['no session was created by ask_project', !mine.some((e) => e.type === 'session_created')],
    ['toolkit wrote out/secret.txt', !!number],
    ['the caller answered with the number in the file', withNumber(answer, number)],
    ...(CALLER === 'claude' ? [['the caller read the file without a card (read grant)', callerReadCards.length === 0]] : []),
  ])
  finish(c, root)
  return ok
}

async function appAccess() {
  const TRIALS = Number(process.env.TRIALS ?? 1)
  const FIXTURE = fileURLToPath(new URL('../src/apps/external/test-fixtures/app.mjs', import.meta.url))
  const log = logger('app-access')
  const root = scratch('cc-app-access-smoke-')
  const cards = []
  const c = await open(root, (e) => {
    // The person's answer to the consent card: always, for this pair
    if (e.type === 'approval_request' && e.detail?.kind === 'project_access') {
      cards.push(`${e.detail.from.name} → ${e.detail.to.name}: ${e.detail.text}`)
      void c.call('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision: 'always' })
    }
  })

  /** A fresh pair of scratch folders, the second holding the counter app, registered as trusted projects with the app shared — one pair per trial, so no trial reads another's session */
  async function pair() {
    const here = mkdtempSync(join(root, 'website-'))
    const there = mkdtempSync(join(root, 'ops-'))
    for (const d of [here, there]) writeFileSync(join(d, 'README.md'), '# scratch\n')
    const appDir = join(there, '.centralu', 'apps', 'counter')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'centralu.app.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'counter',
        name: 'Counter',
        version: '0.1.0',
        description: 'Keeps one shared number for the team: peek reads it, poke sets it.',
        server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] },
      }),
    )
    const pHere = await c.call('projects.add', { path: here })
    const pThere = await c.call('projects.add', { path: there })
    for (const p of [pHere, pThere]) await c.call('projects.setTrusted', { projectId: p.id, trusted: true })
    await c.call('apps.setShared', { appId: 'counter', projectId: pThere.id, shared: true })
    log('projects', pHere.name, '→', pThere.name, '· shared app counter')
    return { here, pHere, pThere }
  }

  /** Tool calls of the turn — a native subagent's too (#222), marked: haiku sometimes hands the whole errand to one */
  const tools = (evs) =>
    evs.flatMap((e) =>
      e.type === 'tool_call' ? [String(e.summary.tool)]
      : e.type === 'subagent_event' && e.step?.type === 'tool_call' ? [`(subagent) ${String(e.step.summary?.tool)}`]
      : [],
    )
  let passed = 0
  for (let i = 1; i <= TRIALS; i++) {
    const { here, pHere, pThere } = await pair()
    const s = await c.call('agents.createSession', { projectId: pHere.id, cwd: here, tool: TOOL, ...(TOOL === 'claude' ? { model: 'haiku' } : {}), permissionPreset: 'auto' })
    const asked = await c.turn(
      s.id,
      'One of my other Centralu projects shares a counter app. Use it to set the shared number to 7, ' +
        'then detach it so it stops taking up your context. Tell me what you did.',
    )
    if (TOOL === 'codex' && !tools(asked).some((t) => t.includes('poke'))) {
      // The thread restarts through resume when the turn ends; let that settle, then go on as the person would
      await new Promise((r) => setTimeout(r, 5000))
      asked.push(...(await c.turn(s.id, 'Go on.')))
    }
    const calls = tools(asked)
    console.log(`\n── Trial ${i}: tool calls ──\n` + (calls.join('\n') || '(none)'))
    console.log('── What it said ──\n' + said(asked).trim().slice(0, 600))
    // Is the tool gone? The agent's own view on the next turn, and the host's answer for that session
    const before = (await c.call('apps.runs', { appId: 'counter', projectId: pThere.id })).filter((r) => r.callerSessionId === s.id).length
    const after = await c.turn(s.id, 'Call the counter app tool mcp__app-counter__peek now, directly, without attaching anything. If you do not have that tool, say exactly: NO SUCH TOOL.')
    const reach = await c.call('apps.reach', { sessionId: s.id, appId: 'counter', projectId: pThere.id })
    const runs = await c.call('apps.runs', { appId: 'counter', projectId: pThere.id })
    const poked = runs.some((r) => r.tool === 'poke' && r.callerSessionId === s.id && r.status === 'ok')
    const refused = after.filter((e) => e.type === 'tool_result').map((e) => String(e.output ?? e.summary ?? '').slice(0, 120))
    console.log('── After detaching ──\n' + (tools(after).join('\n') || '(no tool calls)') + (refused.length ? `\n  results: ${refused.join(' | ')}` : '') + '\n' + said(after).trim().slice(0, 300) + `\n  apps.reach: ${JSON.stringify(reach)}`)
    if (
      verdict([
        ['found it (find_apps)', calls.some((t) => t.includes('find_apps'))],
        ['attached it (attach_app)', calls.some((t) => t.includes('attach_app'))],
        [TOOL === 'claude' ? 'used poke in the same turn' : 'used poke (next turn)', calls.some((t) => t.includes('poke')) && poked],
        ['detached it (detach_app)', calls.some((t) => t.includes('detach_app'))],
        // Gone means no call of this session reached the app again — a model may still try the name, and the CLI refuses it
        ['tool gone afterwards', runs.filter((r) => r.callerSessionId === s.id).length === before && reach.reachable === false],
      ])
    )
      passed++
    // The next trial's search should find only its own pair's app
    await c.call('apps.setShared', { appId: 'counter', projectId: pThere.id, shared: false })
  }
  console.log(`\nConsent cards answered: ${cards.length}${cards.length ? `\n  ${cards.join('\n  ')}` : ''}`)
  finish(c, root)
  console.log(`\n${passed}/${TRIALS} trials passed`)
  return passed === TRIALS
}

async function reader() {
  const log = logger('reader')
  const root = scratch('cc-reader-smoke-')
  const shop = mkdtempSync(join(root, 'shop-'))
  const other = mkdtempSync(join(root, 'other-'))
  for (const d of [shop, other]) writeFileSync(join(d, 'README.md'), '# scratch\n')
  const c = await open(root)
  const session = async (projectId, cwd, name, tool) => {
    const s = await c.call('agents.createSession', { projectId, cwd, tool, permissionPreset: 'auto', ...(tool === 'claude' ? { model: 'haiku' } : {}) })
    await c.call('sessions.rename', { sessionId: s.id, name })
    return s.id
  }
  const pShop = await c.call('projects.add', { path: shop })
  const pOther = await c.call('projects.add', { path: other })
  const sibling = await session(pShop.id, shop, 'db-migration', 'claude')
  const stranger = await session(pOther.id, other, 'other-project', 'claude')
  await c.turn(sibling, 'Reply with exactly this sentence and nothing else: We chose pgdump for the nightly backup.')
  await c.turn(stranger, 'Reply with exactly this sentence and nothing else: The zanzibar launch code is 4417.')
  log('seeded: sibling', sibling, '· stranger', stranger)

  const me = await session(pShop.id, shop, 'me', TOOL)
  const asked = await c.turn(
    me,
    'Which other Centralu sessions are in this project, and what did we decide about backups in an earlier conversation? ' +
      'Also: is there anything about "zanzibar" in our past conversations?',
  )
  const calls = asked.filter((e) => e.type === 'tool_call').map((e) => `${e.summary.tool}: ${String(e.summary.title).slice(0, 80)}`)
  const results = asked.filter((e) => e.type === 'tool_result').map((e) => String(e.output ?? e.summary ?? ''))
  const answer = said(asked)
  console.log('\n── Tool calls ──\n' + (calls.join('\n') || '(none)'))
  console.log('\n── What it said ──\n' + answer.trim().slice(0, 900) + '\n')
  // A turn that says nothing is a turn that failed — show what happened instead of only "not called"
  if (!answer.trim()) console.log('── Events ──\n' + asked.map((e) => (e.type === 'error' || e.type === 'notice' ? `${e.type}: ${JSON.stringify(e.error ?? e.text)}` : e.type)).join('\n'))

  const leaked = answer.includes('4417') || results.some((r) => r.includes('4417') || r.includes(stranger))
  const ok = verdict([
    ['read_session called', calls.some((t) => t.includes('read_session'))],
    ['recall called', calls.some((t) => t.includes('recall'))],
    ["found the sibling's decision", answer.includes('db-migration') && /pg_?dump/i.test(answer)],
    ['other project stayed out', !leaked],
  ])
  finish(c, root)
  return ok
}

const CASES = { 'start-agent': startAgent, 'ask-project': askProject, 'app-access': appAccess, reader }
const run = CASES[process.argv[2]]
if (!run) {
  console.error(`Usage: node packages/agent-host/scripts/smoke-delegation.mjs <${Object.keys(CASES).join('|')}>`)
  process.exit(2)
}
process.exit((await run()) ? 0 : 1)
