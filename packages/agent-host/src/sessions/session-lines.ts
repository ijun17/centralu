import type { StoredMessage } from '@cc/protocol'
import { authorOf } from './transcript-view.js'

/**
 * A session's conversation as read_session shows it: one JSON line per message, a response's several messages as one
 * line, a tool call folded to its title, and every line marked with who wrote it (#838). Moved out of the seat's
 * `readSession` (#1186) so a line can be read from an offset with the very same merging the plain read uses.
 */

/**
 * The longest text one line shows in a plain read. Past it the line is cut, and says where and how to read on
 * (#1186): it used to be cut at 2,000 characters of its JSON with no word of it, so the middle of a long answer, which
 * ask_project's cut sent the caller here to find, could not be read at all.
 */
export const LINE_MAX_CHARS = 2000
/** How much of one line a read from an offset shows: a long answer is read in a few calls, not one per 2,000 characters */
export const LINE_WINDOW_CHARS = 8000

/**
 * The most characters one read_session call returns for its lines when `maxChars` is not given (#1480). A call used to
 * have no total: 40 lines of up to 2,000 characters each came back as about 80,000 characters, all of it read again on
 * every later request of the reader. Large enough that the common read is one call: each further call re-reads the
 * reader's own context
 */
export const READ_BUDGET_CHARS = 12_000
/** The smallest and largest `maxChars` a read takes; a value outside is brought to the nearest */
export const READ_BUDGET_MIN = 2000
export const READ_BUDGET_MAX = 40_000

/** What a read shows of a tool call: nothing, its first line cut at 100 characters, or its whole title */
export type ToolLines = 'none' | 'titles' | 'full'
/** `tools` as a caller gives it: the old `true`/`false`, or the three words; absent is `titles` */
export const toolLinesOf = (tools: boolean | ToolLines | undefined): ToolLines => (tools === true ? 'full' : tools === false || tools === undefined ? 'titles' : tools)
/** `maxChars` as a caller gives it, within bounds, 12,000 when absent */
export const budgetOf = (maxChars: number | undefined): number => Math.min(READ_BUDGET_MAX, Math.max(READ_BUDGET_MIN, Math.floor(maxChars ?? READ_BUDGET_CHARS)))

/** One line, before it is written out: its fields and the seq of its first message, where `around` finds it again */
export type SessionLine = { seq: number; fields: Record<string, unknown> }

/** Who wrote a line another session or an app sent (#838): a child's report or an app's text is not the person's */
function byWhom(payload: unknown): Record<string, string> {
  const author = authorOf(payload)
  return author.kind === 'session' ? { from: author.name } : author.kind === 'app' ? { fromApp: author.name } : author.kind === 'script' ? { fromScript: author.name } : {}
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ')

/**
 * The lines of these rows, in order. Two messages of one response are two paragraphs of one line, as `turnAnswer`
 * joins them (#428). **A tool call is folded up**: expanded, a full script or commit message buries the conversation
 * under it (a dogfooding finding); one line says what happened, and `tools` expands it when it is actually needed.
 */
export function sessionLines(rows: readonly StoredMessage[], opts: { tools?: boolean | ToolLines } = {}): SessionLine[] {
  const lines: SessionLine[] = []
  const tools = toolLinesOf(opts.tools)
  for (const r of rows) {
    const p = r.payload as { text?: string; summary?: { title?: string; tool?: string } }
    if (r.kind === 'text' && r.role === 'assistant') {
      const text = p.text ?? ''
      const last = lines[lines.length - 1]
      if (last && last.fields.role === 'assistant') {
        const before = String(last.fields.text ?? '')
        last.fields.text = before ? `${before}\n\n${text}` : text
      } else {
        lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'assistant', text } })
      }
    } else if (r.kind === 'text') {
      lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'user', ...byWhom(r.payload), text: p.text ?? '' } })
    } else if (r.role === 'system' && (r.payload as { type?: unknown } | null)?.type === 'error') {
      // The error a turn ended with (#1186): its tool's words, which a report names by kind only and points here for
      const error = (r.payload as { error?: { message?: unknown } }).error
      lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'error', text: String(error?.message ?? '') } })
    } else if (r.kind === 'tool_call' && p.summary?.title && tools !== 'none') {
      const title = tools === 'full' ? p.summary.title : p.summary.title.split('\n')[0]!.slice(0, 100)
      lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'tool', tool: p.summary.tool ?? '?', title } })
    }
  }
  return lines
}

/**
 * One line as read_session gives it, from character `from` of its text (or a tool call's title) for at most `max`
 * characters. A line cut says so on itself, still one JSON object: which characters it shows of how many, and the
 * read that goes on (#1186). The call is named without the session's id, which the reader already used and which a
 * linked machine writes in its own, unqualified, form.
 *
 * `offsetRead`: the line answers a read from an offset, and says what it shows even when that is all of it. A hub
 * tells an older machine, which ignores the offset and answers its plain read, by its lines lacking this
 */
export function lineText(line: SessionLine, from = 0, max = LINE_MAX_CHARS, offsetRead = false): string {
  const key = typeof line.fields.text === 'string' ? 'text' : typeof line.fields.title === 'string' ? 'title' : null
  if (!key) return JSON.stringify(line.fields)
  const whole = line.fields[key] as string
  if (from === 0 && whole.length <= max && !offsetRead) return JSON.stringify(line.fields)
  const start = Math.min(Math.max(0, from), whole.length)
  const end = Math.min(whole.length, start + max)
  const more = end < whole.length
  return JSON.stringify({
    ...line.fields,
    [key]: whole.slice(start, end),
    shown: `characters ${start}-${end} of ${whole.length}`,
    ...(more ? { readOn: `read_session with around=${line.seq} and offset=${end} reads on from here` } : {}),
  })
}

/**
 * The lines of one read, as many as fit `maxChars` in all (#1480), and a note at each end that was left out saying how
 * far the read reached and the call that goes on. A plain read fills from the newest line back; one around a spot
 * (`anchor`, an index into `lines`) fills outward from it, a side at a time. The first line always comes, so a read
 * is never empty: it is at most a line's cut (`LINE_MAX_CHARS`) over the budget. The notes are small and not counted.
 */
export function fitLines(lines: readonly SessionLine[], anchor: number | null, maxChars: number): string[] {
  const texts = lines.map((l) => lineText(l))
  let lo = anchor ?? lines.length - 1
  let hi = lo
  let size = texts[lo]?.length ?? 0
  const take = (older: boolean): boolean => {
    const at = older ? lo - 1 : hi + 1
    const text = texts[at]
    if (text === undefined || size + text.length + 1 > maxChars) return false
    size += text.length + 1
    if (older) lo = at
    else hi = at
    return true
  }
  // A plain read goes back only; one around a spot takes a line from each side in turn
  for (let older = true; take(older) || (anchor !== null && take(!older)); ) if (anchor !== null) older = !older
  const out = texts.slice(lo, hi + 1)
  const cut = `Stopped at the ${maxChars}-character budget (maxChars, up to ${READ_BUDGET_MAX}, shows more in one call)`
  const note = (count: number, which: 'older' | 'newer', next: SessionLine | undefined) =>
    JSON.stringify({ note: `${cut}: ${count} ${which} ${count === 1 ? 'line' : 'lines'} of this read are not shown, the ${which === 'older' ? 'newest' : 'oldest'} at ${String(next?.fields.ts)}. read_session with around=${next?.seq} reads on from there.` })
  if (lo > 0) out.unshift(note(lo, 'older', lines[lo - 1]))
  if (hi < lines.length - 1) out.push(note(lines.length - 1 - hi, 'newer', lines[hi + 1]))
  return out
}

/**
 * The lines a linked machine answered a read with, when that machine is from before the budget (#1480) and gave as many
 * as it had: the newest that fit `maxChars`, the newest always, and a note that older ones were left out. The machine's
 * lines carry no seq here, so the note cannot name the `around` that reads on: it says to update that machine
 */
export function fitMachineLines(lines: readonly string[], maxChars: number): string[] {
  let size = 0
  let from = lines.length
  while (from > 0 && (from === lines.length || size + (lines[from - 1]?.length ?? 0) + 1 <= maxChars)) {
    from--
    size += (lines[from]?.length ?? 0) + 1
  }
  if (from === 0) return [...lines]
  const note = `Stopped at the ${maxChars}-character budget: ${from} older ${from === 1 ? 'line' : 'lines'} of this read are not shown. That machine runs a Centralu from before the budget, so it cannot name the read that goes on; update it there, or ask for fewer lines (limit)`
  return [JSON.stringify({ note }), ...lines.slice(from)]
}
