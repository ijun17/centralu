import type { AgentProcess } from '../contract.js'
import { frameRecorder, type FrameRecorder } from '../frames/recorder.js'
import { lineSplitter } from '../../transport/json-lines.js'

/**
 * The frame tap (docs/plans/session-core.md §6.1, #1654): the one place a tool's lines are recorded, for every tool, at its
 * process instead of in each wire's client. It sees what any wire writes: every line to stdin and every line from stdout, in
 * order, and how the process ended. It reads and records only: no line is held, split differently, dropped or changed for
 * whoever reads or writes after it, and the process returned is the one given.
 *
 * Call it before the wire's own reader is attached, so a line is recorded before the wire has seen it (the order the
 * recorder had inside `AcpConnection`). A blank line is not a frame and is not recorded.
 */
export function tapProcess<P extends AgentProcess>(proc: P, recorder: FrameRecorder | undefined): P {
  if (!recorder) return proc
  const out = lineSplitter((line) => line.trim() && recorder.frame('out', line))
  const original: unknown = Reflect.get(proc.stdin, 'write')
  if (typeof original !== 'function') return proc
  // Recorded where it is written, so the order against the lines read is the order they happened in. Called on the stream
  // it came from with the arguments it was given, whatever overload the wire used
  Object.defineProperty(proc.stdin, 'write', {
    configurable: true,
    writable: true,
    value: (chunk: unknown, ...rest: unknown[]): unknown => {
      if (typeof chunk === 'string') out.push(chunk)
      else if (chunk instanceof Uint8Array) out.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      const written: unknown = Reflect.apply(original, proc.stdin, [chunk, ...rest])
      return written
    },
  })
  const incoming = lineSplitter((line) => line.trim() && recorder.frame('in', line))
  proc.stdout.on('data', (chunk: Buffer | string) => incoming.push(chunk))
  proc.once('exit', (code, signal) => recorder.exit(code, signal))
  return proc
}

/** The tap for a session's process, off unless `CC_RECORD_FRAMES` is set (`frames/recorder.ts`) */
export function tapSessionProcess<P extends AgentProcess>(proc: P, sessionId: string): P {
  return tapProcess(proc, frameRecorder(sessionId))
}
