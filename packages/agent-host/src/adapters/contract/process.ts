import type {
  BackgroundTask,
} from '@cc/protocol'
import type { Readable, Writable } from 'node:stream'

/**
 * A tool's process as an adapter drives it — what a local `ChildProcess` and a process the keeper
 * holds (#280 step 2, `keeper/agent-process.ts`) both are. It is also the shape the Agent SDK's
 * `spawnClaudeCodeProcess` returns.
 */
export interface AgentProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr?: Readable | null
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode?: NodeJS.Signals | null
  readonly killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: Error) => void): this
  /** Lets go of the process and leaves it running (only a process someone else holds can) */
  detach?(): Promise<void>
  /**
   * The end of what the process wrote to stderr, for a failure message (`withStderrTail`). The SDK keeps it only for
   * a process it spawned itself; this host's own child (`local-process.ts`) and the keeper's (`keeper/agent-process.ts`)
   * keep it here.
   */
  stderrTail?(): string
}

export type AgentSpawnSpec = { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }

/**
 * Where a session's tool process comes from, when not from the adapter's own `spawn` (#280 step 2).
 *
 * Under the keeper the manager passes this so the process outlives the host: `spawn` starts it
 * in the keeper, and `adopt` hands over one a previous host started — the re-attach after a host
 * restart, with the process possibly mid-turn.
 */
export type ProcessSource = {
  spawn(spec: AgentSpawnSpec): AgentProcess
  adopt?: {
    process: AgentProcess
    /**
     * Tool calls the store recorded for this session with no result yet. A call the previous host
     * was serving in-process died with it, and the tool would wait for that answer forever: the
     * adapter knows which of its calls those are, and releases the turn.
     */
    openCalls: { callId: string; tool: string }[]
    /**
     * The background tasks the previous host last saw running in this process (#648). The tool sends its level only
     * when it changes, so a tracker that starts empty would never list them, and their endings would go unreported:
     * the adapter seeds its tracker with these. Absent or empty when the previous host saw none.
     */
    backgroundTasks?: readonly BackgroundTask[]
  }
}
