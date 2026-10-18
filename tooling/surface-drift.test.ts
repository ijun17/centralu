import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { AdapterSurface, SurfaceEnv, ToolSurface } from '../packages/agent-host/src/adapters/contract.js'
import { baselineSource } from '../packages/agent-host/src/adapters/surface-drift.js'
import { runSurfaceDrift, type Gh } from '../scripts/surface-drift.mjs'

/*
 * The weekly run (#270) with recorded readings and a fake gh: what it files, when it leaves an issue alone, and when it
 * goes red. The readings are cut from the real ones: the Codex adapter's baseline (codex-cli 0.160.0) against 0.163.0.
 */
const baseline = {
  recorded: '2026-10-18',
  version: 'codex-cli 0.160.0',
  offered: { command: ['thread/start', 'turn/start'], message: ['turn/completed', 'skills/changed'] },
}
const latest: ToolSurface = {
  version: 'codex-cli 0.163.0',
  offered: { command: ['thread/attachmentOwner/list', 'thread/start', 'turn/start'], message: ['thread/readState/changed', 'turn/completed', 'skills/changed'] },
}

const surfaceOf = (reading: ToolSurface | Error, over: Partial<AdapterSurface> = {}): AdapterSurface => ({
  gather: async () => ({}),
  read: () => {
    if (reading instanceof Error) throw reading
    return reading
  },
  limitations: [],
  baseline,
  ...over,
})
const env: SurfaceEnv = { packageDir: async () => '', run: async () => '', tempDir: () => '' }

/** A fake gh: answers `issue list` from `open`, records every call */
function fakeGh(open: { number: number; body: string }[] = []) {
  const calls: { args: readonly string[]; input?: string }[] = []
  const gh: Gh = async (args, input) => {
    calls.push({ args, input })
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(open)
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/9\n'
    return ''
  }
  return { gh, calls }
}

const drift = async (surface: AdapterSurface | undefined, opts: { fileIssue?: boolean; record?: boolean; gh?: Gh; write?: (p: string, t: string) => void } = {}) => {
  const lines: string[] = []
  const code = await runSurfaceDrift({ adapters: new Map([['codex', { surface }]]), env, today: '2026-10-25', log: (l) => lines.push(l), ...opts })
  return { code, out: lines.join('\n') }
}

describe('the surface drift run', () => {
  it('stays green and quiet when the tool offers what was reviewed', async () => {
    const { gh, calls } = fakeGh()
    const { code, out } = await drift(surfaceOf({ version: 'codex-cli 0.160.0', offered: baseline.offered }), { fileIssue: true, gh })
    expect(code).toBe(0)
    expect(out).toContain('nothing new since codex-cli 0.160.0')
    expect(calls).toEqual([])
  })

  it('prints what is new and stays green: a finding is news, not a failure', async () => {
    const { code, out } = await drift(surfaceOf(latest))
    expect(code).toBe(0)
    expect(out).toContain('- command `thread/attachmentOwner/list`')
    expect(out).toContain('- message `thread/readState/changed`')
  })

  it('files one issue carrying the report and its marker when none is open', async () => {
    const { gh, calls } = fakeGh([{ number: 3, body: 'an unrelated issue' }])
    const { code, out } = await drift(surfaceOf(latest), { fileIssue: true, gh })
    expect(code).toBe(0)
    const create = calls.find((c) => c.args[1] === 'create')!
    expect(create.args).toContain('Surface drift: codex offers what its adapter has not reviewed')
    expect(create.input).toContain('Read from the latest published codex: codex-cli 0.163.0.')
    expect(create.input).toMatch(/<!-- surface-drift:codex key:[0-9a-f]{16} -->/)
    expect(out).toContain('filed https://github.com/o/r/issues/9')
  })

  it('leaves its open issue alone when the week finds the same things', async () => {
    const first = fakeGh()
    await drift(surfaceOf(latest), { fileIssue: true, gh: first.gh })
    const body = first.calls.find((c) => c.args[1] === 'create')!.input!
    const again = fakeGh([{ number: 9, body }])
    const { out } = await drift(surfaceOf(latest), { fileIssue: true, gh: again.gh })
    expect(again.calls.map((c) => c.args[1])).toEqual(['list'])
    expect(out).toContain('#9 already says this')
  })

  it('rewrites its open issue and says so when the findings changed', async () => {
    const first = fakeGh()
    await drift(surfaceOf(latest), { fileIssue: true, gh: first.gh })
    const body = first.calls.find((c) => c.args[1] === 'create')!.input!
    const moved = { ...latest, offered: { ...latest.offered, message: [...latest.offered.message!, 'thread/prediction/updated'] } }
    const again = fakeGh([{ number: 9, body }])
    await drift(surfaceOf(moved), { fileIssue: true, gh: again.gh })
    expect(again.calls.map((c) => c.args.slice(0, 3).join(' '))).toEqual(['issue list --state', 'issue edit 9', 'issue comment 9'])
    expect(again.calls[1]!.input).toContain('thread/prediction/updated')
  })

  it('goes red when a surface cannot be read, and still reads the others', async () => {
    const lines: string[] = []
    const code = await runSurfaceDrift({
      adapters: new Map([
        ['broken', { surface: surfaceOf(new Error('ServerRequest declares no methods: did the generated shape change?')) }],
        ['codex', { surface: surfaceOf(latest) }],
      ]),
      env,
      log: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('broken: ServerRequest declares no methods')
    expect(lines.join('\n')).toContain('codex: 2 finding(s)')
  })

  it('goes red for a shipped adapter that declares no surface', async () => {
    const { code, out } = await drift(undefined)
    expect(code).toBe(1)
    expect(out).toContain('declares no surface')
  })

  it('goes red when the issue cannot be filed, since then nobody hears of the findings', async () => {
    const gh: Gh = async () => {
      throw new Error('HTTP 403: Resource not accessible by integration')
    }
    const { code, out } = await drift(surfaceOf(latest), { fileIssue: true, gh })
    expect(code).toBe(1)
    expect(out).toContain('HTTP 403')
  })

  it("--record writes the reading as the adapter's baseline file, and compares nothing", async () => {
    const written: [string, string][] = []
    const { gh, calls } = fakeGh()
    const { code } = await drift(surfaceOf(latest), { record: true, fileIssue: true, gh, write: (p, t) => written.push([p, t]) })
    expect(code).toBe(0)
    expect(written).toHaveLength(1)
    expect(written[0]![0].endsWith(join('adapters', 'codex', 'surface-baseline.ts'))).toBe(true)
    expect(written[0]![1]).toBe(baselineSource(latest, '2026-10-25'))
    expect(calls).toEqual([])
  })
})
