import type { NormalizedEvent, TokenUsage } from '@cc/protocol'
import { asObj, str } from '../../json-value.js'
import { loadRecording, type Recording } from '../frames/replay.test-helpers.js'
import { launchArgs } from './launch.js'
import { AgyWire, type TurnEnd, type WireOutput } from './wire.js'

/**
 * Plays an `agy` recording (docs/plans/antigravity-adapter.md §10.2) into the pure wire. The frames/ replayer
 * (`replaySpawner`) stands in for a process that a session writes to; there is no session yet, so this one does the same job
 * for the wire alone, reading the same recordings through the same `loadRecording`: each recorded line the process printed
 * (`in`, `err`, `exit`) is handed to the wire in order, each line it was sent (`out`) is what `startTurn` must write, each
 * `spawn` is what `launchArgs` must give, and each `gate` request must name a call the wire has announced. Nothing waits on
 * a clock. `frames/`'s `ReplayPeer` cannot be used as it is: it plays `in` lines only and has no place for `err`, `gate`
 * and `spawn`, which are most of what makes an `agy` run.
 */

export const RECORDINGS = `${import.meta.dirname}/recordings`

export type Replay = {
  recording: Recording
  events: NormalizedEvent[]
  ends: TurnEnd[]
  /** The conversation ids the wire reported, one per process that got to its `init` */
  externalIds: string[]
  /** How many times the wire asked for the process to be stopped, and that the conversation was not found */
  stops: number
  notFound: number
  /** What the recording and the wire disagreed on; a test asserts it stays empty */
  problems: string[]
  /** The gate requests of conversations the stream never named (a sub-agent's) */
  childGates: string[]
  /** Whether a turn was open when each process exited */
  openAtExit: boolean[]
}

type Options = {
  /** Scenarios whose recording does not say when the Stop was sent: it is said right after the first input */
  stopAfterInput?: boolean
  resume?: string | null
}

const value = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

export function replay(path: string, opts: Options = {}): Replay {
  const recording = loadRecording(path)
  const out: Replay = { recording, events: [], ends: [], externalIds: [], stops: 0, notFound: 0, problems: [], childGates: [], openAtExit: [] }
  let wire = new AgyWire({ sessionId: 's1', resume: null })
  let conversation = ''
  let usage: TokenUsage | undefined
  const announced = new Set<string>()
  const take = (o: WireOutput): void => {
    out.events.push(...o.events)
    for (const e of o.events) {
      if (e.type === 'tool_call') announced.add(e.callId)
      if (e.type === 'usage_update') usage = e.tokens
    }
    if (o.turnEnded) out.ends.push(o.turnEnded)
    if (o.externalId) out.externalIds.push(o.externalId)
    if (o.stop) out.stops++
    if (o.sessionNotFound) out.notFound++
  }
  for (const f of recording.frames) {
    switch (f.dir) {
      case 'spawn': {
        const args = f.args ?? []
        const resume = value(args, '--conversation') ?? null
        const model = value(args, '--model')
        const effort = value(args, '--effort')
        const built = launchArgs({ ...(model ? { model } : {}), ...(effort ? { effort } : {}), pluginRoot: value(args, '--add-dir') ?? '', resume })
        if (JSON.stringify(built) !== JSON.stringify(args)) out.problems.push(`launchArgs gave ${JSON.stringify(built)} where the recording started ${JSON.stringify(args)}`)
        // The core carries the conversation's last reading to the process it starts next
        wire = new AgyWire({ sessionId: 's1', resume, ...(usage ? { usageBefore: usage } : {}) })
        break
      }
      case 'out': {
        const content = str(asObj(f.msg?.message).content)
        const line = wire.startTurn(content)
        if (JSON.stringify(JSON.parse(line)) !== JSON.stringify(f.msg)) out.problems.push(`startTurn wrote ${line} where the recording wrote ${JSON.stringify(f.msg)}`)
        if (opts.stopAfterInput) wire.stopRequested()
        break
      }
      case 'in':
        if (f.msg?.event === 'init') conversation = String(f.msg.conversation_id)
        take(wire.stdout(JSON.stringify(f.msg)))
        break
      case 'err':
        take(wire.stderr(f.text ?? ''))
        break
      case 'gate': {
        const input = asObj(f.msg?.input)
        const id = `${str(input.conversationId)}:${String(input.stepIdx)}`
        // A sub-agent's steps are not in the stream, only at the gate (§4.3): its requests name a conversation `init` did not
        if (str(input.conversationId) !== conversation) out.childGates.push(id)
        else if (!announced.has(id)) out.problems.push(`the gate asked about ${id}, which the wire has not announced as a call`)
        break
      }
      case 'note':
        if (f.msg?.sent === 'SIGINT') wire.stopRequested()
        break
      case 'exit':
        out.openAtExit.push(wire.turnOpen)
        take(wire.exit())
        break
    }
  }
  return out
}

/** The events as short lines, for a test to read: what was drawn, in order */
export function digest(events: readonly NormalizedEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case 'message_delta':
        return `text ${e.messageId} ${JSON.stringify(e.text)}`
      case 'tool_call':
        return `call ${e.callId} ${e.summary.tool}: ${e.summary.title}`
      case 'tool_result':
        return `${e.ok ? 'ok' : 'failed'} ${e.callId}`
      case 'usage_update':
        return `usage ${e.tokens.inputTokens}+${e.tokens.cacheReadTokens}c/${e.tokens.outputTokens}${e.request ? ` request ${e.request.inputTokens}/${e.request.outputTokens}` : ''}`
      case 'files_touched':
        return `files ${e.paths.join(',')}`
      default:
        return e.type
    }
  })
}
