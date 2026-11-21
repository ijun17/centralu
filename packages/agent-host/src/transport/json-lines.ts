import type { Readable } from 'node:stream'
import { lineSplitter } from '../stream-text.js'

/**
 * Newline-delimited JSON (codex's app-server, the keeper's child service and swap control, codex's rollout files; #428). Split at `\n`
 * only, never with `readline`: it also ends a line at U+2028 and U+2029, which JSON leaves raw in a string (Node 26: a `compacted` rollout
 * line holding one came out as two non-JSON lines) and it cut codex's 23,244,422-byte `thread/resume` answer (`codex/client.ts`)
 */
export { lineSplitter, type LineSplitter } from '../stream-text.js'

export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const ready: string[] = []
  const split = lineSplitter((line) => ready.push(line))
  for await (const chunk of stream) {
    split.push(chunk as Buffer | string)
    while (ready.length > 0) yield ready.shift()!
  }
  split.flush()
  while (ready.length > 0) yield ready.shift()!
}
