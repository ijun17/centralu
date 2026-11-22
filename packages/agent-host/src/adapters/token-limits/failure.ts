/**
 * How reading a tool's limits with a token from another tool's file can fail (#2459, #2462). One kind per way, one reason
 * per kind per reader (ux-writing.md §1); the answer degrades to the reason and never blocks the panel or a session
 */
export type LimitsFailureKind = 'no-token' | 'expired' | 'signed-out' | 'refused' | 'unreachable' | 'unreadable'

export type LimitsReasons = Readonly<Record<LimitsFailureKind, string>>

/**
 * `detail` goes to host.log only, and is built from fixed words, a status or an exit code: never the token or an answer.
 * The message is the reader's reason for the kind (`readWithReasons`), and the kind until then
 */
export class LimitsFailure extends Error {
  constructor(
    readonly kind: LimitsFailureKind,
    readonly detail: string,
    reason?: string,
  ) {
    super(reason ?? kind)
  }
}

/**
 * `read` with each failure as its kind carrying the reader's reason; host.log gets one line for each kind the first time it
 * happens in this process
 */
export function readWithReasons<T>(name: string, reasons: LimitsReasons, log: (line: string) => void, read: () => Promise<T>): () => Promise<T> {
  const logged = new Set<LimitsFailureKind>()
  return async () => {
    try {
      return await read()
    } catch (e) {
      const failure = e instanceof LimitsFailure ? e : new LimitsFailure('unreadable', e instanceof Error ? e.name : 'failed')
      if (!logged.has(failure.kind)) {
        logged.add(failure.kind)
        log(`[usage] ${name}: limits not read (${failure.kind}: ${failure.detail})`)
      }
      throw new LimitsFailure(failure.kind, failure.detail, reasons[failure.kind])
    }
  }
}

/** A file error's code (`ENOENT`), for a detail: never its message, which carries the path */
export function fileErrorCode(e: unknown): string {
  const code = ownField(e, 'code')
  return typeof code === 'string' ? code : 'unreadable'
}

export function ownField(e: unknown, name: string): unknown {
  const value: unknown = typeof e === 'object' && e !== null ? Object.getOwnPropertyDescriptor(e, name)?.value : undefined
  return value
}
