import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { pathsOf } from '../../os.js'
import { agyFiles, statPath } from './host-files.js'
import { RECORDINGS } from './replay.test-helpers.js'
import { pluginRootFor } from './plugin-root.js'
import {
  agyAdapter,
  commandCall,
  exitFrame,
  fakeAgyProcesses,
  frame,
  init,
  segmentsOf,
  spawnFrame,
  startHost,
  startSession,
  stepDone,
  success,
  until,
  userFrame,
  type Run,
  type TestHost,
} from './session.test-helpers.js'

/**
 * An `agy` session through the whole stack on a temp host (docs/plans/antigravity-adapter.md, session-core.md §8): the
 * adapter, the core's ledger and process seam, the real front door with its gate route, the hook's own answer through
 * Node's `fetch`, and the plugin root on disk. The `agy` process is scripted from the recordings (or frames written in their
 * shape), so what it prints and what its hook asks are what `agy` did; what the session does with them is the code under test.
 */

const { join } = pathsOf()
const rec = (v: string, name: string) => `${RECORDINGS}/${v}/${name}.jsonl`

const hosts: TestHost[] = []
const runs: Run[] = []
afterEach(async () => {
  for (const r of runs.splice(0)) await r.session.dispose().catch(() => {})
  for (const h of hosts.splice(0)) await h.close()
})

async function setup(segments: ReturnType<typeof segmentsOf>, over: Parameters<typeof startSession>[2] = {}, host?: TestHost) {
  const h = host ?? (await startHost())
  if (!host) hosts.push(h)
  const ref: { run?: Run } = {}
  const fake = fakeAgyProcesses(segments, () => ref.run?.events.length ?? 0)
  const adapter = agyAdapter(h, fake.spawn, 5_000)
  const run = await startSession(adapter, h, over)
  ref.run = run
  runs.push(run)
  return { host: h, run, fake, adapter }
}

const types = (events: readonly NormalizedEvent[]) => events.map((e) => e.type)
const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1]

describe('a turn', () => {
  it('runs a recorded tool turn: the launch, the call, the answer, the end, and the conversation id', async () => {
    const { run, fake, host } = await setup(segmentsOf(rec('agy-1.4.8', 'tool')), { preset: 'auto' })
    run.session.send('Run the shell command `echo gate-ok` with your command tool, then reply with its output only.')
    await until(() => run.of('turn_complete').length === 1, 'the turn to end')
    const spec = fake.procs[0]!.spec
    expect(flag(spec.args, '--model')).toBe('gemini-3.8-flash-low')
    expect(spec.args).toContain('--dangerously-skip-permissions')
    expect(flag(spec.args, '--add-dir')).toBe(pluginRootFor(host.dataDir, 's1'))
    expect(spec.args).not.toContain('--conversation')
    expect(spec.env?.CC_GATE_URL).toMatch(/\/gate\/s1$/)
    expect(spec.env?.CC_GATE_TOKEN).toMatch(/^ccg1:/)
    expect(fake.procs[0]!.answers).toEqual([{ decision: 'allow' }])
    expect(run.of('approval_request')).toEqual([])
    expect(run.of('tool_call')).toHaveLength(1)
    expect(run.of('tool_result')).toHaveLength(1)
    expect(types(run.events).filter((t) => t !== 'session_live').at(-1)).toBe('turn_complete')
    expect(run.session.externalId).toBe('conv-1')
    // The plugin root the process was started with is on disk, read-only, with the hook in it
    const hook = join(pluginRootFor(host.dataDir, 's1'), '.agents', 'plugins', 'centralu', 'hooks.json')
    expect(JSON.parse(await agyFiles.readFile(hook, 'utf8'))).toHaveProperty('centralu-gate')
  })

  it('queues an input sent in a turn: one turn at a time on one process', async () => {
    const turn = (n: number, text: string) => [userFrame, ...(n === 1 ? [init('conv-1')] : []), stepDone('conv-1', n, text), success('conv-1', text)]
    const { run, fake } = await setup([[spawnFrame, ...turn(1, 'one'), ...turn(2, 'two')]])
    run.session.send('first')
    run.session.send('second')
    await until(() => run.of('turn_complete').length === 2, 'both turns')
    expect(fake.procs).toHaveLength(1)
    expect(run.of('message_delta').map((e) => (e as { text: string }).text)).toEqual(['one', 'two'])
  })
})

describe('a tool card', () => {
  async function toCard(name: 'tool' | 'gate-deny') {
    const s = await setup(segmentsOf(rec('agy-1.4.8', name)), { preset: 'normal' })
    s.run.session.send('run it')
    await until(() => s.run.of('approval_request').length === 1, 'the card')
    return s
  }

  it('allow: the card is the command, the hook gets the person’s answer, and the turn goes on', async () => {
    const { run, fake } = await toCard('tool')
    const card = run.of('approval_request')[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    expect(card.detail).toMatchObject({ kind: 'command', command: 'echo gate-ok' })
    expect(fake.procs[0]!.answers).toEqual([])
    expect(run.session.respondApproval(card.requestId, 'allow')).toBe(true)
    await until(() => run.of('turn_complete').length === 1, 'the turn to end')
    expect(fake.procs[0]!.answers).toEqual([{ decision: 'allow' }])
    expect(run.of('approval_resolved')).toMatchObject([{ requestId: card.requestId, decision: 'allow' }])
  })

  it('deny: the hook is told the person declined', async () => {
    const { run, fake } = await toCard('gate-deny')
    const card = run.of('approval_request')[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    run.session.respondApproval(card.requestId, 'deny')
    await until(() => run.of('turn_complete').length === 1, 'the turn to end')
    expect(fake.procs[0]!.answers).toEqual([{ decision: 'deny', reason: 'The person declined.' }])
  })

  it('the person’s deny rule refuses the call with no card', async () => {
    const host = await startHost()
    hosts.push(host)
    await agyFiles.mkdir(join(host.home, '.gemini', 'antigravity-cli'), { recursive: true })
    await agyFiles.writeFile(join(host.home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ permissions: { deny: ['command(echo gate-ok)'] } }))
    const { run, fake } = await setup(segmentsOf(rec('agy-1.4.8', 'tool')), { preset: 'auto' }, host)
    run.session.send('run it')
    await until(() => run.of('turn_complete').length === 1, 'the turn to end')
    expect(run.of('approval_request')).toEqual([])
    expect(fake.procs[0]!.answers[0]).toMatchObject({ decision: 'deny', reason: expect.stringContaining('command(echo gate-ok)') })
  })
})

describe('a Stop', () => {
  it('with a card open: the card is denied before SIGINT, the process ends, and the session is not crashed', async () => {
    const { run, fake } = await setup(segmentsOf(rec('agy-1.4.8', 'stop-card')), { preset: 'normal' })
    run.session.send('run it')
    await until(() => run.of('approval_request').length === 1, 'the card')
    run.session.interrupt()
    await until(() => run.events.some((e) => e.type === 'state_change' && e.state === 'waiting_input'), 'the turn to end')
    const proc = fake.procs[0]!
    expect(proc.answers).toEqual([{ decision: 'deny', reason: 'The turn was stopped.' }])
    // The card was withdrawn before the signal was sent: `agy` does not act on SIGINT while a hook waits
    const sigint = proc.signals.find((s) => s.signal === 'SIGINT')!
    expect(sigint).toBeDefined()
    expect(run.events.slice(0, sigint.events).some((e) => e.type === 'approval_resolved' && e.decision === 'deny')).toBe(true)
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' }))
    expect(run.of('error')).toEqual([])
    expect(run.of('session_live')).toEqual([])
  })

  it('then the next input starts a new process on the same conversation', async () => {
    const { run, fake } = await setup(segmentsOf(rec('agy-1.4.7', 'interrupt')), { preset: 'auto' })
    run.session.send('Count from 1 to 200, one number per line, no other text. Do not use any tool.')
    await until(() => run.of('message_delta').length > 0, 'the answer to begin')
    run.session.interrupt()
    await until(() => run.events.some((e) => e.type === 'state_change' && e.state === 'waiting_input'), 'the stop')
    run.session.send('Reply with exactly the single word: resumed. Do not use any tool.')
    await until(() => run.of('turn_complete').length === 1, 'the next turn')
    expect(fake.procs).toHaveLength(2)
    expect(flag(fake.procs[1]!.spec.args, '--conversation')).toBe('conv-1')
    // A new gate key for the new process
    expect(fake.procs[1]!.spec.env?.CC_GATE_TOKEN).not.toBe(fake.procs[0]!.spec.env?.CC_GATE_TOKEN)
    expect(run.of('error')).toEqual([])
  })
})

describe('resume', () => {
  const resumed = (id: string) => [spawnFrame, userFrame, init(id), stepDone(id, 4, 'resumed'), success(id, 'resumed')]

  it('the process ending while idle is sleep, not a crash: the conversation is kept by the tool', async () => {
    const first = [spawnFrame, userFrame, init('conv-1'), stepDone('conv-1', 1, 'one'), success('conv-1', 'one'), exitFrame(0)]
    const { run, fake } = await setup([first])
    run.session.send('hello')
    await until(() => run.of('turn_complete').length === 1, 'the first turn')
    // The process goes while idle: the session sleeps and the conversation is kept by the tool
    await until(() => run.of('session_live').length === 1, 'the process to be seen gone')
    expect(run.of('error')).toEqual([])
    expect(fake.procs).toHaveLength(1)
  })

  it('a new session resumes the conversation of the old one, after the host restarted', async () => {
    const dirs = await startHost()
    const first = await setup([[spawnFrame, userFrame, init('conv-1'), stepDone('conv-1', 1, 'one'), success('conv-1', 'one')]], { preset: 'auto' }, dirs)
    first.run.session.send('hello')
    await until(() => first.run.of('turn_complete').length === 1, 'the first turn')
    const id = first.run.session.externalId
    expect(id).toBe('conv-1')
    const oldKey = first.fake.procs[0]!.spec.env?.CC_GATE_TOKEN
    await first.run.session.dispose()
    const oldUrl = first.fake.procs[0]!.spec.env?.CC_GATE_URL
    // The host restarts: a new front door on another port, the same folders
    const dirsOnly = { dataDir: dirs.dataDir, home: dirs.home, cwd: dirs.cwd }
    await dirs.close()
    hosts.splice(hosts.indexOf(dirs), 1)
    const next = await startHost(dirsOnly)
    hosts.push(next)
    const second = await setup([resumed('conv-1')], { preset: 'auto', resumeExternalId: id! }, next)
    expect(second.run.session.externalId).toBe('conv-1')
    second.run.session.send('again')
    await until(() => second.run.of('turn_complete').length === 1, 'the resumed turn')
    const spec = second.fake.procs[0]!.spec
    expect(flag(spec.args, '--conversation')).toBe('conv-1')
    expect(spec.env?.CC_GATE_URL).not.toBe(oldUrl)
    expect(spec.env?.CC_GATE_TOKEN).not.toBe(oldKey)
    expect(second.run.of('error')).toEqual([])
  })

  it('a conversation agy does not have fails the turn instead of running it in a new one', async () => {
    const { run } = await setup(segmentsOf(rec('agy-1.4.8', 'unknown-id')), { preset: 'auto', resumeExternalId: 'gone-conv' })
    run.session.send('hello')
    await until(() => run.of('error').length > 0, 'the failure')
    expect(run.of('error')[0]).toMatchObject({ error: { code: 'session_not_found' } })
    expect(run.of('turn_complete')).toEqual([])
  })
})

describe('a preset change between turns', () => {
  it('takes effect at the next call, with no new process', async () => {
    const call = (n: number, command: string) => [userFrame, ...(n === 0 ? [init('conv-1')] : []), ...commandCall('conv-1', n * 3 + 1, command), stepDone('conv-1', n * 3 + 3, 'done'), success('conv-1', 'done')]
    const { run, fake } = await setup([[spawnFrame, ...call(0, 'echo one'), ...call(1, 'echo two')]], { preset: 'normal' })
    run.session.send('first')
    await until(() => run.of('approval_request').length === 1, 'the first card')
    run.session.respondApproval((run.of('approval_request')[0] as { requestId: string }).requestId, 'allow')
    await until(() => run.of('turn_complete').length === 1, 'the first turn')
    run.session.setPermissionPreset?.('auto')
    run.session.send('second')
    await until(() => run.of('turn_complete').length === 2, 'the second turn')
    expect(run.of('approval_request')).toHaveLength(1)
    expect(fake.procs).toHaveLength(1)
    expect(fake.procs[0]!.answers).toEqual([{ decision: 'allow' }, { decision: 'allow' }])
  })

  it('a model change starts the next process with the new flag and the conversation’s id', async () => {
    const turn = (id: string, text: string) => [spawnFrame, userFrame, init(id), stepDone(id, 1, text), success(id, text)]
    const { run, fake } = await setup([turn('conv-1', 'one'), turn('conv-1', 'two')], { preset: 'auto' })
    run.session.send('first')
    await until(() => run.of('turn_complete').length === 1, 'the first turn')
    run.session.updateSettings?.({ model: 'gemini-3.8-pro' })
    run.session.send('second')
    await until(() => run.of('turn_complete').length === 2, 'the second turn')
    expect(fake.procs).toHaveLength(2)
    expect(flag(fake.procs[0]!.spec.args, '--model')).toBe('gemini-3.8-flash-low')
    expect(flag(fake.procs[1]!.spec.args, '--model')).toBe('gemini-3.8-pro')
    expect(flag(fake.procs[1]!.spec.args, '--conversation')).toBe('conv-1')
    expect(run.of('error')).toEqual([])
  })
})

describe('closing', () => {
  it('revokes the gate key and removes the plugin root', async () => {
    const live = [spawnFrame, userFrame, init('conv-1'), stepDone('conv-1', 1, 'x'), success('conv-1', 'x')]
    const { run, host, fake } = await setup([live], { preset: 'auto' })
    run.session.send('run it')
    await until(() => run.of('turn_complete').length === 1, 'the turn')
    expect(host.gates.size).toBe(1)
    await run.session.dispose()
    expect(host.gates.size).toBe(0)
    await expect(statPath(pluginRootFor(host.dataDir, 's1'))).rejects.toThrow()
    expect(fake.procs[0]!.killed || fake.procs[0]!.exitCode !== null).toBe(true)
  })

  it('the exit of the process revokes its key', async () => {
    const { run, host } = await setup([[spawnFrame, userFrame, init('conv-1'), success('conv-1', 'x'), exitFrame(0)]], { preset: 'auto' })
    run.session.send('x')
    await until(() => run.of('session_live').length === 1, 'the exit')
    await until(() => host.gates.size === 0, 'the key to be revoked')
  })
})

// A hand-written frame keeps the unused import honest
void frame
