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
import { callOrder, loadRecording, of, replaySpawner } from '../frames/replay.test-helpers.js'
import { drive, scenariosFor } from '../frames/scenarios.test-helpers.js'

/**
 * The adapter against recordings of the real tools (docs/plans/acp-adapter.md §10, #1498). Each recording was made by
 * `scripts/frames-record.mts` driving this adapter through the same scenario, so the replay checks every frame the adapter
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

async function replay(dir: string, name: string): Promise<{ events: NormalizedEvent[]; problems: string[]; left: number; sent: Record<string, unknown>[] }> {
  const recording = loadRecording(join(RECORDINGS, dir, `${name}.jsonl`))
  const tool = dir.replace(/-[^-]*$/, '')
  const named = scenariosFor(tool).find((s) => s.name === name)!
  // Driven under the preset it was recorded with (`frames-record.mts` writes it; older recordings ran under Normal)
  const preset = PermissionPreset.safeParse(recording.header.preset)
  const scenario = preset.success ? { ...named, preset: preset.data } : named
  const { spawn: replayed, state, peers } = replaySpawner(recording)
  // What the adapter wrote to the agent, parsed (the replay matches a request by its method alone)
  const sent: Record<string, unknown>[] = []
  const spawn = (spec: Parameters<typeof replayed>[0]) => {
    const peer = replayed(spec)
    let buffer = ''
    peer.stdin.on('data', (d: Buffer) => {
      buffer += String(d)
      for (let n = buffer.indexOf('\n'); n >= 0; n = buffer.indexOf('\n')) {
        if (buffer.slice(0, n).trim()) sent.push(JSON.parse(buffer.slice(0, n)) as Record<string, unknown>)
        buffer = buffer.slice(n + 1)
      }
    })
    return peer
  }
  const adapter = new ReplayAdapter(profile(dir, String(recording.header.version)), spawn, 60_000)
  const events = await drive(adapter, scenario, '/work', `replay-${name}`, 0, () => peers.at(-1)?.kill('SIGKILL'), { tool, session: { centraluBridge: { url: 'ws://127.0.0.1:0', token: 'replay' } }, replay: state })
  return { events, problems: state.problems, left: state.left(), sent }
}

for (const dir of readdirSync(RECORDINGS)) {
  const names = readdirSync(join(RECORDINGS, dir))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .filter((n) => scenariosFor(dir.replace(/-[^-]*$/, '')).some((s) => s.name === n))
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
        if (asked.length === 0) {
          // `files` runs under auto, where a tool may ask nothing (OpenCode 1.19.4: its model found no delete tool and stopped, measured):
          // no card to read, but a delete call must not go by unnoticed when a later version adds one
          const kinds = recording.frames.map((f) => (f.msg as { params?: { update?: { kind?: string } } } | undefined)?.params?.update?.kind)
          expect(kinds).not.toContain('delete')
          return
        }
        const deletes = asked.filter((a) => a.detail.kind === 'file_edit' && a.detail.change === 'delete')
        expect(deletes.length).toBeGreaterThan(0)
        // Every request the agent titled a delete reads as one (Cursor: "Delete `<path>`", its kind `edit`)
        expect(asked.filter((a) => /^Delete\b/.test(a.title) && !(a.detail.kind === 'file_edit' && a.detail.change === 'delete'))).toEqual([])
      })
    }

    if (names.includes('files')) {
      it('files: a file is marked after the edit that wrote it ended ok, never before (#843)', async () => {
        const { events } = await replay(dir, 'files')
        const touched = events.map((e, i) => ({ e, i })).filter((x) => x.e.type === 'files_touched')
        expect(touched.length).toBeGreaterThan(0)
        for (const { i } of touched) {
          const before = events[i - 1]
          expect(before?.type === 'tool_result' && before.ok).toBe(true)
        }
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

    if (names.includes('resume') && dir.startsWith('opencode-')) {
      it('resume, priced: the turn after the restart reports what it added to the total kept beside the session', async () => {
        // The recording as it is, but for its two running totals: OpenCode's free model costs 0 every turn, so the
        // amounts are a paid model's (one turn before the restart, one after it)
        const recording = loadRecording(join(RECORDINGS, dir, 'resume.jsonl'))
        const totals = [0.0123, 0.0311]
        let priced = 0
        for (const f of recording.frames) {
          const update = (f.msg as { params?: { update?: { sessionUpdate?: string; cost?: { amount: number } } } } | undefined)?.params?.update
          if (update?.sessionUpdate === 'usage_update' && update.cost) update.cost.amount = totals[priced++]!
        }
        expect(priced).toBe(2)
        // What `LaunchRecords.runningCostFor` keeps in the store, for the two processes of one session
        let kept: number | null = null
        class Kept extends ReplayAdapter {
          override createSession(opts: Parameters<AcpAdapter['createSession']>[0], emit: Parameters<AcpAdapter['createSession']>[1]) {
            return super.createSession({ ...opts, runningCost: { last: opts.resumeExternalId ? kept : null, keep: (t) => (kept = t) } }, emit)
          }
        }
        const { spawn, state, peers } = replaySpawner(recording)
        const adapter = new Kept(profile(dir, String(recording.header.version)), spawn, 60_000)
        const scenario = scenariosFor(dir.replace(/-[^-]*$/, '')).find((s) => s.name === 'resume')!
        const events = await drive(adapter, { ...scenario, preset: 'normal' }, '/work', 'replay-resume', 0, () => peers.at(-1)?.kill('SIGKILL'), { replay: state })
        expect(state.problems).toEqual([])
        expect(state.spawned).toBe(2)
        expect(of(events, 'usage_update').map((e) => e.tokens.costUsd)).toEqual([expect.closeTo(0.0123, 6), expect.closeTo(0.0188, 6)])
        expect(kept).toBeCloseTo(0.0311, 6)
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

    if (names.includes('tool-error')) {
      it('tool-error: a read of a missing file ends not ok with the tool’s words, a command’s stderr is its output, and the turn goes on to its end', async () => {
        const { events } = await replay(dir, 'tool-error')
        const reads = of(events, 'tool_call').filter((c) => c.summary.tool === 'Read')
        expect(reads).toHaveLength(1)
        expect(of(events, 'tool_result').find((r) => r.callId === reads[0]!.callId)).toMatchObject({ ok: false, summary: expect.stringContaining('missing-file.txt') })
        expect(of(events, 'tool_output_delta').some((d) => d.text.includes('boom'))).toBe(true)
        // As the tool reports it: `completed`, with the exit code only in its raw output (`metadata.exit: 3`). A command that failed reads ok (#2045)
        const commands = of(events, 'tool_call').filter((c) => c.summary.tool === 'Bash')
        expect(of(events, 'tool_result').find((r) => r.callId === commands[0]!.callId)?.ok).toBe(true)
        expect(of(events, 'turn_complete')).toHaveLength(1)
        expect(of(events, 'error')).toEqual([])
      })
    }

    if (names.includes('long-output')) {
      it('long-output: a command whose output the tool cuts is one card, streamed in pieces, that keeps the tool’s own note of the cut', async () => {
        const { events } = await replay(dir, 'long-output')
        const calls = of(events, 'tool_call')
        expect(calls).toHaveLength(1)
        expect(of(events, 'tool_output_delta').length).toBeGreaterThan(5)
        const result = of(events, 'tool_result')[0]!
        expect(result).toMatchObject({ callId: calls[0]!.callId, ok: true })
        expect(result.output).toContain('output truncated')
        expect(result.output).toContain('line 6000')
        expect(of(events, 'turn_complete')).toHaveLength(1)
      })
    }

    if (names.includes('markdown')) {
      it('markdown: a long Markdown answer arrives whole, as the pieces the tool streamed it in, with no tool call', async () => {
        const { events } = await replay(dir, 'markdown')
        const text = of(events, 'message_delta').map((e) => e.text).join('')
        expect(text).toMatch(/^#+ \S/m)
        expect(text).toMatch(/^- \S/m)
        expect(text).toContain('```')
        expect(text).toMatch(/^\| Name \| Value \|/m)
        expect(of(events, 'tool_call')).toEqual([])
        expect(of(events, 'turn_complete')).toHaveLength(1)
      })
    }

    if (names.includes('interrupt-tool')) {
      it('interrupt-tool: a Stop while a command runs ends the command’s card and the turn as stopped, and the next turn runs as a new one', async () => {
        const recording = loadRecording(join(RECORDINGS, dir, 'interrupt-tool.jsonl'))
        // The agent updated the command after the first cancel, so the adapter sent the cancel once more (the replay uses every recorded frame)
        expect(recording.frames.filter((f) => f.dir === 'out' && f.msg?.method === 'session/cancel')).toHaveLength(2)
        const { events } = await replay(dir, 'interrupt-tool')
        const call = of(events, 'tool_call')[0]!
        expect(of(events, 'tool_result').filter((r) => r.callId === call.callId)).toHaveLength(1)
        expect(of(events, 'state_change').filter((e) => e.state === 'waiting_input').map((e) => e.reason)).toEqual(['interrupted'])
        expect(of(events, 'turn_complete')).toHaveLength(1)
        expect(of(events, 'error')).toEqual([])
      })
    }

    for (const name of ['centralu-mail', 'centralu-agents'].filter((n) => names.includes(n))) {
      it(`${name}: the adapter hands the agent Centralu’s bridge as an MCP server, and each call the agent makes through it is a card of its own`, async () => {
        const { events, sent } = await replay(dir, name)
        const created = sent.find((f) => f.method === 'session/new') as { params: { mcpServers: { name: string; env: { name: string; value: string }[] }[] } }
        expect(created.params.mcpServers.map((m) => m.name)).toEqual(['centralu'])
        expect(created.params.mcpServers[0]!.env.map((e) => e.name).sort()).toEqual(['CC_BRIDGE_TOKEN', 'CC_HOST_URL', 'CC_SESSION_ID'])
        // The agent asked no permission for them under Normal: the recording holds no request
        expect(of(events, 'approval_request')).toEqual([])
        const calls = of(events, 'tool_call')
        expect(calls.map((c) => c.summary.tool.replace(/^centralu[_-]/, ''))).toEqual(name === 'centralu-mail' ? ['mail', 'mail'] : ['recall', 'read_session', 'start_agent'])
        // The answers are the fixed ones of `frames/fakes.test-helpers.ts`, as the real bridge relayed them
        const results = of(events, 'tool_result')
        expect(results.map((r) => r.ok)).toEqual(calls.map(() => true))
        expect(results[0]!.output).toContain(name === 'centralu-mail' ? 'Docs worker' : 'naming question')
        expect(of(events, 'turn_complete')).toHaveLength(1)
      })
    }

    if (names.includes('out-of-quota')) {
      it('out-of-quota: a plan out of quota answers with one plain sentence and a normal end of turn, which ends as a refusal in the provider’s words', async () => {
        const recording = loadRecording(join(RECORDINGS, dir, 'out-of-quota.jsonl'))
        expect(recording.frames.some((f) => f.dir === 'in' && (f.msg?.result as { stopReason?: string } | undefined)?.stopReason === 'end_turn')).toBe(true)
        const { events } = await replay(dir, 'out-of-quota')
        expect(of(events, 'error')).toMatchObject([{ error: { code: 'internal', message: expect.stringMatching(/refused the turn: Upgrade your plan to continue$/), retryable: false } }])
        expect(of(events, 'turn_complete')).toEqual([])
      })
    }
  })
}
