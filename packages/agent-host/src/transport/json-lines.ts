import type { Readable } from 'node:stream'
import { lineSplitter } from '../stream-text.js'

/**
 * Newline-delimited JSON, as codex's app-server, the keeper's child service and the keeper's swap
 * control speak it, and as codex writes its rollout files (#428).
 *
 * **Split at `\n` only, never with `readline`.** readline also ends a line at U+2028 and U+2029, which
 * JSON leaves raw inside a string (measured, Node 26: a `compacted` rollout line holding one came out
 * as two lines, neither of them JSON). It is also what cut codex's 23,244,422-byte `thread/resume`
 * answer into 22,049,101 bytes plus the rest (`codex/client.ts`). Every reader here splits with
 * `lineSplitter`, which also decodes the bytes as one stream.
 */
export { lineSplitter, type LineSplitter } from '../stream-text.js'

/** The lines of a stream, split at `\n` only (see the file header), as an async iterator, e.g. over a file */
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
