/**
 * #371 part A end to end: **does a real session find a shared app in another project, use one of
 * its tools, detach it, and is the tool then gone?**
 *
 * The unit tests pin the rules (sharing, consent per pair, attach and detach for Claude and Codex).
 * Whether a model, asked in plain words, finds the deferred find_apps through tool search, attaches
 * the app, calls its tool in the same turn, and detaches it — and whether the tool is then really
 * gone from the agent — can only be known here.
 *
 * Two scratch projects under a temp folder; the second has a project app (the runtime's test fixture
 * in its `attach` mode: `peek` reads a number, `poke` sets it), shared by the person. The consent card
 * is answered "always" by this script, as the person would. Nothing touches the real data folder:
 * the host runs in memory with CC_DATA_DIR in the temp folder.
 *
 * Run with: node --import tsx packages/agent-host/scripts/smoke-app-access.mts
 * (TRIALS=5 repeats the asking turn in fresh sessions, to count how often the model finds the tools.
 * TOOL=codex runs the session on Codex: its thread keeps the servers it started with, so the app's
 * tools arrive the turn after attach_app, and the script says "Go on." once, as the person would.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHost, type Json } from './host-client.mjs'

const root = mkdtempSync(join(tmpdir(), 'cc-app-access-smoke-'))
const FIXTURE = fileURLToPath(new URL('../src/apps/external/test-fixtures/app.mjs', import.meta.url))

/** Two fresh scratch folders, the second holding the counter app — one pair per trial, so no trial reads another's session */
function folders(): { here: string; there: string } {
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
  return { here, there }
}
const TRIALS = Number(process.env.TRIALS ?? 1)
const TOOL = (process.env.TOOL ?? 'claude') as 'claude' | 'codex'
const log = (...a: unknown[]) => console.log('[app-access]', ...a)

const cards: string[] = []
const { host, ws, call: rpc, turn } = await openHost({
  env: { CC_DATA_DIR: join(root, 'data') },
  onEvent: (e) => {
    // The person's answer to the consent card: always, for this pair
    if (e.type === 'approval_request' && e.detail?.kind === 'project_access') {
      cards.push(`${e.detail.from.name} → ${e.detail.to.name}: ${e.detail.text}`)
      void rpc('agents.respondApproval', { sessionId: e.sessionId, requestId: e.requestId, decision: 'always' })
    }
  },
})

/** Registers a fresh pair of trusted projects and shares the counter app — the consent card is asked anew for each pair */
async function pair() {
  const { here, there } = folders()
  const pHere = await rpc('projects.add', { path: here })
  const pThere = await rpc('projects.add', { path: there })
  for (const p of [pHere, pThere]) await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  await rpc('apps.setShared', { appId: 'counter', projectId: pThere.id, shared: true })
  log('projects', pHere.name, '→', pThere.name, '· shared app counter')
  return { here, pHere, pThere }
}

/** Tool calls of the turn — a native subagent's too (#222), marked: haiku sometimes hands the whole errand to one */
const tools = (evs: Json[]) =>
  evs.flatMap((e) =>
    e.type === 'tool_call' ? [String(e.summary.tool)]
    : e.type === 'subagent_event' && e.step?.type === 'tool_call' ? [`(subagent) ${String(e.step.summary?.tool)}`]
    : [],
  )
const said = (evs: Json[]) => evs.filter((e) => e.type === 'message_delta').map((e) => e.text).join('').trim()
let passed = 0
for (let i = 1; i <= TRIALS; i++) {
  const { here, pHere, pThere } = await pair()
  const s = await rpc('agents.createSession', { projectId: pHere.id, cwd: here, tool: TOOL, ...(TOOL === 'claude' ? { model: 'haiku' } : {}), permissionPreset: 'auto' })
  const asked = await turn(
    s.id,
    'One of my other Centralu projects shares a counter app. Use it to set the shared number to 7, ' +
      'then detach it so it stops taking up your context. Tell me what you did.',
  )
  if (TOOL === 'codex' && !tools(asked).some((c) => c.includes('poke'))) {
    // The thread restarts through resume when the turn ends; let that settle, then go on as the person would
    await new Promise((r) => setTimeout(r, 5000))
    asked.push(...(await turn(s.id, 'Go on.')))
  }
  const calls = tools(asked)
  console.log(`\n── Trial ${i}: tool calls ──\n` + (calls.join('\n') || '(none)'))
  console.log('── What it said ──\n' + said(asked).slice(0, 600))
  // Is the tool gone? The agent's own view on the next turn, and the host's answer for that session
  const before = (await rpc('apps.runs', { appId: 'counter', projectId: pThere.id })).filter((r: Json) => r.callerSessionId === s.id).length
  const after = await turn(s.id, 'Call the counter app tool mcp__app-counter__peek now, directly, without attaching anything. If you do not have that tool, say exactly: NO SUCH TOOL.')
  const afterCalls = tools(after)
  const reach = await rpc('apps.reach', { sessionId: s.id, appId: 'counter', projectId: pThere.id })
  const runs = await rpc('apps.runs', { appId: 'counter', projectId: pThere.id })
  const poked = runs.some((r: Json) => r.tool === 'poke' && r.callerSessionId === s.id && r.status === 'ok')
  const checks = {
    'found it (find_apps)': calls.some((c) => c.includes('find_apps')),
    'attached it (attach_app)': calls.some((c) => c.includes('attach_app')),
    [TOOL === 'claude' ? 'used poke in the same turn' : 'used poke (next turn)']: calls.some((c) => c.includes('poke')) && poked,
    'detached it (detach_app)': calls.some((c) => c.includes('detach_app')),
    // Gone means no call of this session reached the app again — a model may still try the name, and the CLI refuses it
    'tool gone afterwards': runs.filter((r: Json) => r.callerSessionId === s.id).length === before && reach.reachable === false,
  }
  const refused = after.filter((e) => e.type === 'tool_result').map((e) => String(e.output ?? e.summary ?? '').slice(0, 120))
  console.log('── After detaching ──\n' + (afterCalls.join('\n') || '(no tool calls)') + (refused.length ? `\n  results: ${refused.join(' | ')}` : '') + '\n' + said(after).slice(0, 300) + `\n  apps.reach: ${JSON.stringify(reach)}`)
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(28)} ${v ? '✅' : '❌'}`)
  if (Object.values(checks).every(Boolean)) passed++
  // The next trial's search should find only its own pair's app
  await rpc('apps.setShared', { appId: 'counter', projectId: pThere.id, shared: false })
}
console.log(`\nConsent cards answered: ${cards.length}${cards.length ? `\n  ${cards.join('\n  ')}` : ''}`)

ws.close()
host.kill()
rmSync(root, { recursive: true, force: true })
console.log(`\n${passed}/${TRIALS} trials passed`)
process.exit(passed === TRIALS ? 0 : 1)
