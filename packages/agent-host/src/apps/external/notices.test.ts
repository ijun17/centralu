import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppCaller, type AppRef } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { fakeBrokerHost, memoryLedger, until } from './test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * An app's notice into a session that called it (#1161 item 1): with `uses.notices` declared, a call a session started
 * carries that session's address, and the app posts there later from a timer, with no call in progress. Exercised with
 * an app expanded from the template (the helper, the broker, the desk and the address are the product's own); the
 * session side is a recording `appNotice`, and the manager's delivery has its own test (app-notice.test.ts).
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = tempRoot('cc-app-notices-')
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  await removeTree(root)
})

const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const session: AppCaller = { kind: 'session', sessionId: 's1' }

/**
 * A template app: `address` answers the address its call carried; `later` posts `text` to `to` from a timer, after the
 * call has ended, and writes whether it was taken into `told.json` in its data folder.
 */
function plant(id: string, { notices = true } = {}): void {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: id, description: `${id} app` })
  const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8')) as Record<string, unknown>
  if (notices) manifest.uses = { notices: true }
  writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'
serveStdio(() => {
  const server = new McpServer({ name: '${id}', version: '0' }, { capabilities: { tools: {} } })
  const say = (t) => ({ content: [{ type: 'text', text: String(t) }] })
  centralu.tool(server, 'address', { description: 'Address', _meta: { ui: { visibility: ['model', 'app'] } } }, async () => say(centralu.noticeAddress()))
  centralu.tool(server, 'later', { description: 'Later', inputSchema: z.object({ to: z.string(), text: z.string() }) }, async ({ to, text }) => {
    setTimeout(async () => centralu.writeJson('told.json', { taken: await centralu.notify(to, text) }), 50)
    return say('scheduled')
  })
  return server
})
`,
  )
}

function runtime(): { rt: ExternalApps; told: { sessionId: string; text: string; app: { appId: string; name: string } }[] } {
  const told: { sessionId: string; text: string; app: { appId: string; name: string } }[] = []
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  rt.attachBrokerHost(
    fakeBrokerHost({
      appNotice: async (sessionId, text, app) => {
        if (sessionId === 'gone') throw new Error('that session is gone')
        told.push({ sessionId, text, app: { appId: app.appId, name: app.name } })
      },
    }),
  )
  return { rt, told }
}

async function call(r: ExternalApps, appId: string, tool: string, args: Record<string, unknown> = {}, caller: AppCaller = session): Promise<string> {
  const out = await r.call(ref(appId), tool, args, caller)
  expect(out.status).toBe('ok')
  return resultText(out.result!)
}

/** What the app wrote once its timer's notice was answered */
async function taken(appId: string): Promise<boolean> {
  const file = join(dataRoot, 'app-data', 'p1', appId, 'told.json')
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as { taken: boolean }
    } catch {
      return null
    }
  }
  return (await until(read, (v) => v !== null))!.taken
}

describe("an app's notice into a session that called it (#1161 item 1)", () => {
  it('a call from a session carries its address, and the app posts there from a timer after the call ended', async () => {
    plant('queue')
    const { rt: r, told } = runtime()
    const address = await call(r, 'queue', 'address')
    expect(address).toMatch(/^s1\./)
    expect(await call(r, 'queue', 'later', { to: address, text: 'Merge queue: merged #77.' })).toBe('scheduled')
    expect(await taken('queue')).toBe(true)
    expect(told).toEqual([{ sessionId: 's1', text: 'Merge queue: merged #77.', app: { appId: 'queue', name: 'queue' } }])
    // The person reads in the app's Runs panel what it told which session
    const rows = r.runs(ref('queue'), 20).filter((x) => x.tool === 'notify')
    expect(rows.map((x) => x.status)).toEqual(['ok'])
    expect(rows[0]!.argsSummary).toContain('s1')
  })

  it('a call from a view carries no address, and an app that does not declare notices gets none and cannot post', async () => {
    plant('queue')
    plant('quiet', { notices: false })
    const { rt: r, told } = runtime()
    expect(await call(r, 'queue', 'address', {}, { kind: 'view', instanceId: 'v1' } as AppCaller)).toBe('null')
    expect(await call(r, 'quiet', 'address')).toBe('null')
    const forQueue = await call(r, 'queue', 'address')
    await call(r, 'quiet', 'later', { to: forQueue, text: 'hello' })
    expect(await taken('quiet')).toBe(false)
    expect(told).toEqual([])
  })

  it("refuses an address it was not given: another app's, or one made up from a session id", async () => {
    plant('queue')
    plant('other')
    const { rt: r, told } = runtime()
    const forOther = await call(r, 'other', 'address')
    await call(r, 'queue', 'later', { to: forOther, text: 'not yours' })
    expect(await taken('queue')).toBe(false)
    const [, mac] = forOther.split('.')
    writeFileSync(join(dataRoot, 'app-data', 'p1', 'queue', 'told.json'), 'pending')
    await call(r, 'queue', 'later', { to: `s2.${mac}`, text: 'made up' })
    expect(await taken('queue')).toBe(false)
    expect(told).toEqual([])
    const refused = r.runs(ref('queue'), 20).filter((x) => x.tool === 'notify')
    expect(refused.map((x) => x.status)).toEqual(['rejected', 'rejected'])
  })

  it('the address survives a new host on the same data folder (a swap), and a session that is gone is refused', async () => {
    plant('queue')
    const first = runtime()
    const address = await call(first.rt, 'queue', 'address')
    await first.rt.dispose()
    // A host swap: the next host checks the same address with the key it finds in the data folder
    const { rt: r, told } = runtime()
    await call(r, 'queue', 'later', { to: address, text: 'after the swap' })
    expect(await taken('queue')).toBe(true)
    expect(told.map((t) => t.sessionId)).toEqual(['s1'])
    // The session went: refused, with the reason in the app's Runs panel
    const goneAddress = await call(r, 'queue', 'address', {}, { kind: 'session', sessionId: 'gone' })
    writeFileSync(join(dataRoot, 'app-data', 'p1', 'queue', 'told.json'), 'pending')
    await call(r, 'queue', 'later', { to: goneAddress, text: 'too late' })
    expect(await taken('queue')).toBe(false)
    expect(r.runs(ref('queue'), 20).find((x) => x.tool === 'notify' && x.status === 'rejected')?.error).toContain('that session is gone')
  })
})
