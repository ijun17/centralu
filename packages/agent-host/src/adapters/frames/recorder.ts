import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
/** Which way a line went: to the tool, or from it */
export type FrameDirection = 'in' | 'out'

export type FrameRecorder = {
  frame(direction: FrameDirection, line: string): void
  exit(code: number | null, signal: string | null): void
}

/**
 * The frame recorder (docs/plans/acp-adapter.md §10.1, #1498): a dev-only switch, `CC_RECORD_FRAMES=<folder>`, writes every
 * line a session sends its tool and receives from it (any line protocol: ACP, a stream-json CLI), in order and with its time, and how its process ended, to
 * `<folder>/<session id>.<n>.jsonl`, one file per process: a process that is killed after its grace reports its end after the
 * next one has started (measured: Cursor does not exit on stdin EOF), so one file per session would interleave them. The file is raw: paths, ids and whatever the person typed are in it, so it becomes a
 * fixture only through `scripts/frames-scrub.mts`.
 */
const processes = new Map<string, number>()

export function frameRecorder(sessionId: string, env: NodeJS.ProcessEnv = process.env): FrameRecorder | undefined {
  const dir = env.CC_RECORD_FRAMES
  if (!dir) return undefined
  mkdirSync(dir, { recursive: true })
  const n = (processes.get(sessionId) ?? 0) + 1
  processes.set(sessionId, n)
  const file = join(dir, `${sessionId}.${n}.jsonl`)
  const start = Date.now()
  const write = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(file, `${JSON.stringify({ t: Date.now() - start, ...entry })}\n`)
    } catch (e) {
      console.error('[acp] recorder could not write', file, (e as Error).message)
    }
  }
  return {
    frame: (direction, line) => write({ dir: direction, line }),
    exit: (code, signal) => write({ dir: 'exit', msg: { code, sig: signal } }),
  }
}
