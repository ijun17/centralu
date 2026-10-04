/**
 * Writes one host.log line, once per session, the first time an adapter receives a message type that it neither maps
 * nor ignores on purpose (#58, #270).
 *
 * Both adapters drop what they do not know, as protocol.md §4 requires, so a type a vendor adds or starts sending
 * reaches nobody. The #58 survey (2026-10-04) found that the hard way. `/clear` sent Claude's `conversation_reset`
 * and Codex 0.160.0 stopped sending `thread/compacted`, and nothing on screen or in a log said so. This class does not
 * change what reaches the screen. It only makes the first instance of an unknown type one grep away, which is the
 * "wire it when it is observed" rule of #58 put into practice.
 *
 * `known` holds what the adapter maps plus what the survey classified as correctly ignored. A type the survey wants
 * shown but nobody has wired yet stays out of `known` on purpose: the log line is how its first real instance is found.
 */
export class UnmappedTypes {
  private readonly seen = new Set<string>()

  constructor(
    private readonly tool: string,
    private readonly sessionId: string,
    private readonly known: ReadonlySet<string>,
  ) {}

  note(type: string): void {
    if (!type || this.known.has(type) || this.seen.has(type)) return
    this.seen.add(type)
    console.error(`[${this.tool}] ${this.sessionId.slice(0, 8)} unmapped message type: ${type}`)
  }
}
