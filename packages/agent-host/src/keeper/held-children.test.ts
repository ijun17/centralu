import { describe, expect, it } from 'vitest'
import { sortKept } from './held-children.js'
import type { KeptChild } from './children-client.js'

/** What a host does with each child a previous host left in the keeper (#280 step 2) */

const child = (id: string, tag: unknown, alive = true): KeptChild => ({
  id,
  kind: 'pipes',
  pid: 100,
  cmd: 'x',
  args: [],
  cwd: '/p',
  startedAt: 1,
  alive,
  exit: alive ? null : { code: 0, signal: null },
  tag,
  cols: 90,
  rows: 30,
  buffered: 0,
  attached: false,
})

const adopt = {
  agent: (c: KeptChild) => ({ adopted: c.id }) as never,
  pty: (c: KeptChild) => ({ adopted: c.id }) as never,
}

describe('sorting what the keeper holds', () => {
  it('takes over live agents, terminals and runs, and a run that ended alone', () => {
    const { kept, release } = sortKept(
      [
        child('c1', { kind: 'agent', tool: 'claude', sessionId: 's1' }),
        child('c2', { kind: 'terminal', id: 'term-2', cwd: '/p' }),
        child('c3', { kind: 'command', cwd: '/p', command: 'pnpm dev', runId: 'run-1', startedAt: 5 }),
        child('c4', { kind: 'command', cwd: '/p', command: 'pnpm build', runId: 'run-2', startedAt: 6 }, false),
      ],
      adopt,
    )
    expect(kept.agents).toEqual([{ sessionId: 's1', tool: 'claude', process: { adopted: 'c1' } }])
    expect([...kept.sessionIds]).toEqual(['s1'])
    expect(kept.terminals).toEqual([{ id: 'term-2', cwd: '/p', pty: { adopted: 'c2' }, cols: 90, rows: 30 }])
    expect(kept.runs.map((r) => r.runId)).toEqual(['run-1', 'run-2'])
    expect(release).toEqual([])
  })

  it('hands on the CLI version an agent tag carries, and none for a tag written before #297', () => {
    const { kept } = sortKept(
      [
        child('c1', { kind: 'agent', tool: 'claude', sessionId: 's1', version: '2.1.282' }),
        child('c2', { kind: 'agent', tool: 'codex', sessionId: 's2' }),
      ],
      adopt,
    )
    expect(kept.agents).toEqual([
      { sessionId: 's1', tool: 'claude', process: { adopted: 'c1' }, version: '2.1.282' },
      { sessionId: 's2', tool: 'codex', process: { adopted: 'c2' } },
    ])
  })

  it('releases an exited agent or terminal — there is nothing to take over', () => {
    const { kept, release } = sortKept(
      [child('c1', { kind: 'agent', tool: 'codex', sessionId: 's1' }, false), child('c2', { kind: 'terminal', id: 'term-1', cwd: '/p' }, false)],
      adopt,
    )
    expect(kept.agents).toEqual([])
    expect(kept.sessionIds.size).toBe(0)
    expect(release).toEqual(['c1', 'c2'])
  })

  it('leaves a child with a tag it does not read alone — a newer build may have spawned it', () => {
    const { kept, release } = sortKept([child('c9', { kind: 'browser', url: 'x' }), child('c8', null)], adopt)
    expect(kept.agents.length + kept.terminals.length + kept.runs.length).toBe(0)
    expect(release).toEqual([])
  })
})
