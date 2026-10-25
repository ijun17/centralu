import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent } from '@cc/protocol'
import { AcpAdapter } from './adapter.js'
import type { AcpProfile } from './profile.js'
import { loadRecording, replaySpawner } from '../frames/replay.test-helpers.js'
import { drive, SCENARIOS } from '../frames/scenarios.test-helpers.js'

/**
 * The adapter against recordings of the real tools (docs/plans/acp-adapter.md §10, #1498). Each recording was made by
 * `scripts/acp-record.mts` driving this adapter through the same scenario, so the replay checks every frame the adapter
 * sends against what it sent to the real agent, and what it makes of what the agent answered.
 */

const RECORDINGS = fileURLToPath(new URL('./recordings/', import.meta.url))

class ReplayAdapter extends AcpAdapter {
  readonly tool = 'replay'
}

const profile = (version: string): AcpProfile => ({
  descriptor: { name: 'replay', label: 'Agent', mark: 'R', install: 'install it', login: 'log in' },
  capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true } as AdapterCapabilities,
  surface: undefined as never,
  launch: async () => ({ command: 'agent', args: ['acp'] }),
  detect: async () => ({ tool: 'replay', installed: true, loggedIn: true, detail: '' }),
  installedVersion: async () => version,
})

async function replay(dir: string, name: string): Promise<{ events: NormalizedEvent[]; problems: string[]; left: number }> {
  const recording = loadRecording(join(RECORDINGS, dir, `${name}.jsonl`))
  const scenario = SCENARIOS.find((s) => s.name === name)!
  const { spawn, state, peers } = replaySpawner(recording)
  const adapter = new ReplayAdapter(profile(String(recording.header.version)), spawn, 60_000)
  const events = await drive(adapter, scenario, '/work', `replay-${name}`, 0, () => peers.at(-1)?.kill('SIGKILL'))
  return { events, problems: state.problems, left: state.left() }
}

const of = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T) => events.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === type)

for (const dir of readdirSync(RECORDINGS)) {
  const names = readdirSync(join(RECORDINGS, dir))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .filter((n) => SCENARIOS.some((s) => s.name === n))
  describe(`replaying ${dir}`, () => {
    for (const name of names) {
      it(`${name}: sends what it sent to the real agent, and uses every recorded frame`, async () => {
        const r = await replay(dir, name)
        expect(r.problems).toEqual([])
        expect(r.left).toBe(0)
      })
    }

    if (names.includes('approval')) {
      it('approval: asks with a card the command reads on, answers by kind, and keeps "always" as its own rule', async () => {
        const { events } = await replay(dir, 'approval')
        const cards = of(events, 'approval_request')
        // The fourth run of the same command is answered by the rule, without a card
        expect(cards).toHaveLength(3)
        expect(cards.map((c) => (c.detail.kind === 'command' ? c.detail.command : c.detail.kind))).toEqual(['echo probe-1', 'echo probe-2', 'echo probe-3'])
        expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['allow', 'deny', 'always'])
        expect(of(events, 'turn_complete')).toHaveLength(4)
      })
    }

    if (names.includes('interrupt-approval')) {
      it('interrupt-approval: a Stop closes the open card and ends the turn as stopped', async () => {
        const { events } = await replay(dir, 'interrupt-approval')
        expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['deny'])
        expect(of(events, 'state_change').filter((e) => e.state === 'waiting_input').map((e) => e.reason)).toEqual(['interrupted'])
      })
    }

    if (names.includes('die')) {
      it('die: a process that dies mid-turn is a crash the manager hears', async () => {
        const { events } = await replay(dir, 'die')
        expect(of(events, 'error').map((e) => e.error.code)).toEqual(['adapter_crashed'])
      })
    }

    if (names.includes('resume')) {
      it('resume: a new process loads the conversation, and the replayed history is not taken for the new turn', async () => {
        const { events } = await replay(dir, 'resume')
        const reopened = events.findIndex((e, i) => i > 0 && e.type === 'agent_version')
        const before = events.slice(reopened).findIndex((e) => e.type === 'state_change' && e.state === 'working')
        expect(of(events.slice(reopened, reopened + before), 'message_delta')).toEqual([])
        expect(of(events, 'turn_complete')).toHaveLength(2)
      })
    }

    if (names.includes('compact')) {
      it('compact: a /compact answered with ordinary text leaves no compaction marker', async () => {
        const { events } = await replay(dir, 'compact')
        expect(of(events, 'compaction')).toEqual([])
        expect(of(events, 'turn_complete')).toHaveLength(3)
      })
    }

    if (names.includes('queued')) {
      it('queued: a message sent during a turn runs as a turn of its own after it', async () => {
        const { events } = await replay(dir, 'queued')
        expect(of(events, 'turn_complete')).toHaveLength(2)
        expect(of(events, 'state_change').filter((e) => e.state === 'working')).toHaveLength(2)
      })
    }
  })
}
