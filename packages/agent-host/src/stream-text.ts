import { StringDecoder } from 'node:string_decoder'

/**
 * Text read off a child's stream, kept or split, in one place (#428).
 *
 * A pipe hands bytes over in chunks of whatever size the OS chose, and a chunk can end inside a
 * multibyte character. Decoding each chunk on its own (`chunk.toString('utf8')`) turns both halves
 * of that character into U+FFFD: a Korean or emoji line in a crash reason came out as `��`. Every
 * reader here decodes through one `StringDecoder` per stream, which holds the unfinished bytes
 * back until the rest arrives. A string chunk (a stream with `setEncoding`) is already whole.
 */

/** Text from a byte or string chunk, with a character split across chunks kept whole */
function decoderFor(): (chunk: Buffer | string) => string {
  const decoder = new StringDecoder('utf8')
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk))
}

/** The last `max` characters of a stream of text: memory stays at `max` however much is written */
export class Tail {
  private kept = ''
  private readonly decode = decoderFor()
  constructor(private readonly max: number) {}
  push(chunk: Buffer | string): void {
    this.kept += this.decode(chunk)
    if (this.kept.length > this.max) this.kept = this.kept.slice(-this.max)
  }
  get text(): string {
    return this.kept
  }
}

/** The last `maxLines` lines given to it, each cut to `maxChars` (with `…`): a crash reason's few lines */
export class LineTail {
  private lines: string[] = []
  constructor(
    private readonly maxLines: number,
    private readonly maxChars: number,
  ) {}
  push(line: string): void {
    this.lines.push(line.length > this.maxChars ? `${line.slice(0, this.maxChars)}…` : line)
    if (this.lines.length > this.maxLines) this.lines.shift()
  }
  get text(): string {
    return this.lines.join('\n')
  }
  /** A copy of the kept lines */
  snapshot(): string[] {
    return [...this.lines]
  }
}

export type LineSplitter = {
  /** Feeds a chunk; every line it completes goes to `onLine`, without its `\n` or a `\r` before it */
  push(chunk: Buffer | string): void
  /** Hands over what is left after the last newline as a line of its own, if anything is */
  flush(): void
}

/**
 * Splits a stream into lines, decoding it as one stream (see the file header). A line ends at `\n`;
 * a `\r` before it (Windows, a CRLF PowerShell) is not part of the line.
 *
 * `maxLine`: an unfinished line longer than this is handed over as it is, so a stream that never
 * writes a newline does not grow memory without end. Absent, a line can be any length: codex's
 * `thread/resume` answer was measured at 23 MB on one line, and a cut there is a lost answer.
 */
export function lineSplitter(onLine: (line: string) => void, opts: { maxLine?: number } = {}): LineSplitter {
  const decode = decoderFor()
  let partial = ''
  const emit = (line: string) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  return {
    push(chunk) {
      partial += decode(chunk)
      let nl
      while ((nl = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, nl)
        partial = partial.slice(nl + 1)
        emit(line)
      }
      if (opts.maxLine !== undefined && partial.length > opts.maxLine) {
        const line = partial
        partial = ''
        emit(line)
      }
    },
    flush() {
      const line = partial
      partial = ''
      if (line) emit(line)
    },
  }
}

/**
 * A failure message with the end of the process's stderr added, as the Agent SDK does for a process
 * it spawned itself. Both adapters' processes come from this host or the keeper, which keep that end
 * (`stderrTail` on `AgentProcess`); one that keeps none, or a message that already carries it, is
 * returned as it is.
 */
export function withStderrTail(message: string, proc: { stderrTail?(): string } | null | undefined): string {
  if (!proc?.stderrTail || message.includes('stderr:')) return message
  const tail = proc.stderrTail().trim().slice(-2000)
  return tail ? `${message}. stderr: ${tail}` : message
}
