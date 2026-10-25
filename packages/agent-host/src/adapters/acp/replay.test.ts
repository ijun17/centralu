import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PermissionPreset, type NormalizedEvent } from '@cc/protocol'
import { cursorProfile } from '../cursor-agent/index.js'
import { openCodeProfile } from '../opencode/index.js'
import { AcpAdapter } from './adapter.js'
import { AcpNormalizer } from './normalize.js'
import { detailOf } from './session.js'
import { readUpdate, RequestPermission } from './wire.js'
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

/** The tool's own profile, by the recording's folder (`<tool>-<version>`), started on the recording instead of its CLI */
const PROFILES: Record<string, () => AcpProfile> = { 'cursor-agent': cursorProfile, opencode: openCodeProfile }

const profile = (dir: string, version: string): AcpProfile => {
  const tool = Object.keys(PROFILES).find((t) => dir.startsWith(`${t}-`))
  if (!tool) throw new Error(`no profile for the recordings in ${dir}`)
  return { ...PROFILES[tool]!(), launch: async () => ({ command: 'agent', args: ['acp'] }), installedVersion: async () => version }
}

async function replay(dir: string, name: string): Promise<{ events: NormalizedEvent[]; problems: string[]; left: number }> {
  const recording = loadRecording(join(RECORDINGS, dir, `${name}.jsonl`))
  const named = SCENARIOS.find((s) => s.name === name)!
  // Driven under the preset it was recorded with (`acp-record.mts` writes it; older recordings ran under Normal)
  const preset = PermissionPreset.safeParse(recording.header.preset)
  const scenario = preset.success ? { ...named, preset: preset.data } : named
  const { spawn, state, peers } = replaySpawner(recording)
  const adapter = new ReplayAdapter(profile(dir, String(recording.header.version)), spawn, 60_000)
  const events = await drive(adapter, scenario, '/work', `replay-${name}`, 0, () => peers.at(-1)?.kill('SIGKILL'))
  return { events, problems: state.problems, left: state.left() }
}

/** What is wrong with the calls' order: a result before its call, a call with no result or two */
function callOrder(events: NormalizedEvent[]): string[] {
  const wrong: string[] = []
  const results = new Map<string, number>()
  const called = new Set<string>()
  for (const e of events) {
    if (e.type === 'tool_call') called.add(e.callId)
    if (e.type !== 'tool_result') continue
    if (!called.has(e.callId)) wrong.push(`${e.callId}: a result before its call`)
    results.set(e.callId, (results.get(e.callId) ?? 0) + 1)
  }
  for (const id of called) if (results.get(id) !== 1) wrong.push(`${id}: ${results.get(id) ?? 0} results`)
  return wrong
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
        // Every call the agent announced ends once, after it: a recording whose frames came out of order reads wrong here
        // (#1562 review: a `completed` moved before its `tool_call` passed every other check)
        expect(callOrder(r.events)).toEqual([])
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

      it('approval: each command reads its output, and the refused one ends not ok', async () => {
        const { events } = await replay(dir, 'approval')
        const results = of(events, 'tool_result').filter((r) => events.some((e) => e.type === 'tool_call' && e.callId === r.callId && e.summary.tool === 'Bash'))
        expect(results.map((r) => r.ok)).toEqual([true, false, true, true])
        expect(results.map((r) => r.summary.trim())).toEqual(['probe-1', expect.stringMatching(/\S/), 'probe-3', 'probe-3'])
      })
    }

    if (names.includes('files')) {
      it('files: a request about a delete reads as a delete, whatever kind the request itself says', () => {
        // The card as the session makes it: the call's frames so far, then the request (`AcpSession.onRequest`)
        const recording = loadRecording(join(RECORDINGS, dir, 'files.jsonl'))
        const normalizer = new AcpNormalizer('s')
        const asked: { title: string; detail: ReturnType<typeof detailOf> }[] = []
        for (const f of recording.frames) {
          const msg = f.msg as { method?: string; params?: unknown } | undefined
          if (f.dir !== 'in' || !msg?.method) continue
          if (msg.method === 'session/update') {
            const read = readUpdate(msg.params)
            if (read && 'update' in read) normalizer.update(read.update)
          }
          if (msg.method === 'session/request_permission') {
            const req = RequestPermission.parse(msg.params)
            asked.push({ title: req.toolCall.title ?? '', detail: detailOf(normalizer.call(req.toolCall, true), '/work') })
          }
        }
        const deletes = asked.filter((a) => a.detail.kind === 'file_edit' && a.detail.change === 'delete')
        expect(deletes.length).toBeGreaterThan(0)
        // Every request the agent titled a delete reads as one (Cursor: "Delete `<path>`", its kind `edit`)
        expect(asked.filter((a) => /^Delete\b/.test(a.title) && !(a.detail.kind === 'file_edit' && a.detail.change === 'delete'))).toEqual([])
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
      // A /compact answered with text only: a compaction is read from it only for a tool that says so (`infersCompaction`),
      // and only where its context reading went down (OpenCode); Cursor reads none
      const infers = !!profile(dir, '').infersCompaction
      it(`compact: Centralu's /compact answered with ordinary text leaves ${infers ? 'one manual compaction marker' : 'no compaction marker'}`, async () => {
        const { events } = await replay(dir, 'compact')
        expect(of(events, 'compaction')).toEqual(infers ? [{ type: 'compaction', sessionId: 'replay-compact', failed: false, trigger: 'manual' }] : [])
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
