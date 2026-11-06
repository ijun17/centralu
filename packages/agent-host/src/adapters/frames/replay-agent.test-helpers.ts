import type { ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, EventSink, SessionHandle } from '../contract.js'
import { CLAUDE_RECORDINGS, CLAUDE_REPLAY_SESSION, replayedClaudeAdapter } from '../claude/recorded.test-helpers.js'
import { loadRecording, newestVersion, recordedFolders, replaySpawner, streamJsonCodec, type FrameCodec, type Recording, type ReplayPeer } from './replay.test-helpers.js'
import { notingCentraluTools } from './fakes.test-helpers.js'
import { scenariosFor } from './scenarios.test-helpers.js'

/**
 * A recorded session as the agent of a running host (#1498, step 2): the real adapter, started on a session as it is for a
 * person, with the tool's process replaced by a recording (`replaySpawner`). What the UI shows of such a session is what the
 * real adapter made of the frames the real tool sent, not a turn written for the test (`links/scripted-agent.test-helpers.ts`).
 *
 * A session replays the scenario its working folder is named after, so one host serves every recording of a tool and a
 * test picks the scenario with the project it opens. The person's part is the test's: it types the prompts the recording
 * holds and answers its cards. A line the adapter sends that the recording does not hold is a problem; both it and the
 * end of a process are written to stderr as they happen (`PROBLEM`, `ENDED`), which the test that started the host reads:
 * a host stopped by its test is not given the time to say it at the end.
 *
 * Another tool's recordings are one more row of `REPLAYED`, with the adapter that speaks to it, the codec of its frames and
 * the folder its recordings are in. Nothing else here knows a tool.
 */

export type ReplayedTool = {
  tool: ToolName
  /** One folder per tool version, each with the scenarios recorded in it */
  recordings: string
  /** The real adapter, told nothing about the replay: its process comes from `CreateSessionOpts.processSource` */
  adapter(): AgentAdapter
  /** What "the same frame" means in the tool's protocol; `cwd` is the folder the session runs in */
  codec(cwd: string, recording: Recording): FrameCodec
  /** The session's options as the recording was made with them: what the host adds to a session that the recorded run did not have is taken away */
  session(opts: CreateSessionOpts, scenario: string, recording: Recording): CreateSessionOpts
}

export const REPLAYED: readonly ReplayedTool[] = [
  {
    tool: 'claude',
    recordings: CLAUDE_RECORDINGS,
    adapter: replayedClaudeAdapter,
    // A recording made through a host holds the host's answers to the CLI's calls to Centralu's tools, which a replay host does not give the same words
    codec: (cwd, recording) => streamJsonCodec(cwd, { hostAnswers: recording.header.host === true }),
    session(opts, scenario, recording) {
      const named = scenariosFor('claude').find((s) => s.name === scenario)
      const session: CreateSessionOpts = { ...opts, ...CLAUDE_REPLAY_SESSION, model: named?.model ?? CLAUDE_REPLAY_SESSION.model }
      // The host gives every session Centralu's own tools and the attached apps; the recorded run had what its scenario adds (fakes answering in the host's place), or, of a host's, tools it served
      delete session.orchestratorTools
      delete session.apps
      return { ...session, ...named?.session?.(), ...(recording.header.host === true ? { orchestratorTools: notingCentraluTools([]), toolProfile: 'reader' as const } : {}) }
    },
  },
]

/** Start of the stderr line for a frame the adapter sent that the recording does not hold, then `<scenario>: <what>` */
export const PROBLEM = '[replay] problem'
/** Start of the stderr line for a process that ended, then `<scenario>: own=<frames of its own it was not given> later=<frames of the processes after it>` */
export const ENDED = '[replay] ended'
/** Start of the stderr line for the moment every frame of the recording has been written to the adapter, then `<scenario>`: a recording that ends with no process exit has no `ENDED` to say it */
export const DRAINED = '[replay] drained'
/** Start of the stderr line for a process the adapter started, then `<scenario>` */
export const STARTED = '[replay] started'

/** What the adapter asks the machine's own tool for, which a replay has no use for: left out, as an adapter that cannot says */
const OFFLINE = new Set<PropertyKey>(['installedVersion', 'listUsage', 'localUsage', 'account', 'setup'])

/** The scenarios recorded for the tool, in any version */
export const recordedScenarios = (row: ReplayedTool): string[] => [...new Set(recordedFolders(row.recordings).flatMap((f) => f.names))]

/** The file of `scenario`'s recording in the newest recorded version that holds it */
export function recordingFile(row: ReplayedTool, scenario: string): string {
  if (!recordedScenarios(row).includes(scenario)) throw new Error(`no ${row.tool} recording "${scenario}"; the session's folder is named after the scenario it replays (recorded: ${recordedScenarios(row).join(', ')})`)
  return recordedFolders(row.recordings).find((f) => f.dir === newestVersion(row.recordings, scenario))!.file(scenario)
}

export function replayAdapters(tools: readonly ReplayedTool[] = REPLAYED): Map<ToolName, AgentAdapter> {
  const adapters = new Map<ToolName, AgentAdapter>()
  for (const row of tools) {
    const real = row.adapter()
    /** A session's recording is played through once, over all the processes it starts: a restart goes on from where the last process ended */
    const replays = new Map<string, { recording: Recording; spawn: (spec: AgentSpawnSpec) => AgentProcess }>()
    const replayOf = (opts: CreateSessionOpts, scenario: string) => {
      const known = replays.get(opts.sessionId)
      if (known) return known
      const recording = loadRecording(recordingFile(row, scenario))
      const { spawn, state } = replaySpawner(recording, row.codec(opts.cwd, recording), (problem) => console.error(`${PROBLEM} ${scenario}: ${problem}`))
      const started = (spec: AgentSpawnSpec) => {
        const process = spawn(spec) as ReplayPeer
        console.error(`${STARTED} ${scenario}`)
        process.stdout.on('data', () => {
          if (state.left() === 0) console.error(`${DRAINED} ${scenario}`)
        })
        process.once('exit', () => console.error(`${ENDED} ${scenario}: own=${process.left()} later=${state.left() - process.left()}`))
        return process
      }
      const made = { recording, spawn: started }
      replays.set(opts.sessionId, made)
      return made
    }
    /** The conversations the tool would keep: a restart looks for the one it resumes before it starts a process */
    const opened: { cwd: string; handle: SessionHandle }[] = []
    const createSession = async (opts: CreateSessionOpts, emit: EventSink) => {
      const scenario = opts.cwd.split(/[\\/]/).filter(Boolean).at(-1)!
      const { recording, spawn } = replayOf(opts, scenario)
      const handle = await real.createSession({ ...row.session(opts, scenario, recording), processSource: { spawn } }, emit)
      opened.push({ cwd: opts.cwd, handle })
      return handle
    }
    adapters.set(
      row.tool,
      new Proxy(real, {
        get(target, prop) {
          if (prop === 'createSession') return createSession
          if (prop === 'detect') return async () => ({ tool: row.tool, installed: true, loggedIn: true, detail: 'replay' })
          if (prop === 'listExternalSessions') return async (cwd: string) => opened.filter((o) => o.cwd === cwd && o.handle.externalId).map((o) => ({ externalId: o.handle.externalId!, title: 'replay', updatedAt: Date.now() }))
          if (prop === 'listModels') return async () => [{ id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, tiers: [] }]
          if (OFFLINE.has(prop)) return undefined
          const value: unknown = Reflect.get(target, prop, target)
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      }),
    )
  }
  return adapters
}
