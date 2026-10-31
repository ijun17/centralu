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
  // A tool call left out (`none`) still ends the text before it (#1480): the texts either side stay two lines, as they
  // are when the call is shown, so the end of a turn is not folded into a line cut at its start
  let afterLeftOutTool = false
  for (const r of rows) {
    const p = r.payload as { text?: string; summary?: { title?: string; tool?: string } }
    if (r.kind === 'text' && r.role === 'assistant') {
      const text = p.text ?? ''
      const last = lines[lines.length - 1]
      if (last && last.fields.role === 'assistant' && !afterLeftOutTool) {
        const before = String(last.fields.text ?? '')
        last.fields.text = before ? `${before}\n\n${text}` : text
      } else {
        lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'assistant', text } })
      }
      afterLeftOutTool = false
    } else if (r.kind === 'text') {
      lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'user', ...byWhom(r.payload), text: p.text ?? '' } })
    } else if (r.role === 'system' && (r.payload as { type?: unknown } | null)?.type === 'error') {
      // The error a turn ended with (#1186): its tool's words, which a report names by kind only and points here for
      const error = (r.payload as { error?: { message?: unknown } }).error
      lines.push({ seq: r.seq, fields: { ts: stamp(r.ts), role: 'error', text: String(error?.message ?? '') } })
    } else if (r.kind === 'tool_call' && p.summary?.title && tools === 'none') {
      afterLeftOutTool = true
    } else if (r.kind === 'tool_call' && p.summary?.title) {
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
 * How much of one line a read shows: 2,000 characters at the default budget, more as `maxChars` grows (a sixth of it, up
 * to what a read from an offset shows), so a reader who asks for 40,000 sees the middle of a long answer too (#1480)
 */
export const lineCutOf = (maxChars: number): number => Math.min(LINE_WINDOW_CHARS, Math.max(LINE_MAX_CHARS, Math.floor(maxChars / 6)))

type Window = { lo: number; hi: number }

/** The window of `texts` around `start` that fits `budget`, a line costing its length and a newline; `start` always comes */
function pick(texts: readonly string[], start: number, sides: 'older' | 'both' | 'newer', budget: number): Window {
  const w = { lo: start, hi: start }
  let size = (texts[start]?.length ?? 0) + 1
  const take = (older: boolean): boolean => {
    const at = older ? w.lo - 1 : w.hi + 1
    const text = texts[at]
    if (text === undefined || size + text.length + 1 > budget) return false
    size += text.length + 1
    if (older) w.lo = at
    else w.hi = at
    return true
  }
  // One side only, or a line from each side in turn
  for (let older = sides !== 'newer'; take(older) || (sides === 'both' && take(!older)); ) if (sides === 'both') older = !older
  return w
}

/**
 * The window that fits `maxChars` **with its notes**: the notes are lines of the answer, so they are counted, and a
 * window that overshoots by them is taken again with less. The first line always comes, so a read is never empty.
 */
function fitWith(texts: readonly string[], start: number, sides: 'older' | 'both' | 'newer', maxChars: number, notes: (w: Window) => { older?: string; newer?: string }): string[] {
  if (texts.length === 0) return []
  let budget = maxChars
  for (;;) {
    const w = pick(texts, start, sides, budget)
    const n = notes(w)
    const out = [...(n.older ? [n.older] : []), ...texts.slice(w.lo, w.hi + 1), ...(n.newer ? [n.newer] : [])]
    const total = out.reduce((sum, t) => sum + t.length + 1, 0)
    if (total <= maxChars || w.lo === w.hi) return out
    budget -= total - maxChars
  }
}

/** Which way a read fills: back from the newest line, forward from the oldest, or outward from a spot (`around`, an index) */
export type Fill = 'back' | 'forward' | { around: number }

/**
 * What the call that reads on repeats of this one (#1487): the `tools` and `maxChars` the reader gave, so following a
 * note reads the same way and not with the defaults; and whether this read is answered to a hub, whose own
 * read_session may be older than the `before` and `from` the notes name
 */
export type ReadOn = { tools?: ToolLines; maxChars?: number; viaHub?: boolean }

/** The arguments a note's call repeats: `tools` when it is not the default, `maxChars` when it was given */
function repeated(readOn: ReadOn): string {
  return `${readOn.tools && readOn.tools !== 'titles' ? ` tools=${readOn.tools}` : ''}${readOn.maxChars !== undefined ? ` maxChars=${budgetOf(readOn.maxChars)}` : ''}`
}

/**
 * The lines of one read, as many as fit `maxChars` in all, **notes included** (#1480). A plain read fills from the newest
 * line back; a read `from` a line, forward; one around a spot, outward from it a side at a time. A side left out gets a
 * note saying how many lines and the call that reads on **from where this read stopped**, so following it shows
 * nothing twice: `before` for what is older than the oldest line shown, `from` for what starts at the first one not
 * shown. The first line always comes: a read is at most a line's cut over the budget.
 */
export function fitLines(lines: readonly SessionLine[], fill: Fill, maxChars: number, readOn: ReadOn = {}): string[] {
  const cut = lineCutOf(maxChars)
  const texts = lines.map((l) => lineText(l, 0, cut))
  const stopped = `Stopped at the ${maxChars}-character budget (maxChars, up to ${READ_BUDGET_MAX}, shows more in one call)`
  const again = repeated(readOn)
  /*
   * A hub from before `before` and `from` strips them from the call (its schema lacks them) and the machine answers the
   * newest lines again: said here, with the call every hub takes (#1487)
   */
  const hubNote = (seq: number | undefined) => (readOn.viaHub ? ` If your read_session takes no before or from, the hub needs an update to read on; until then around=${seq} reads near the same spot.` : '')
  const many = (n: number, which: string) => `${n} ${which} ${n === 1 ? 'line' : 'lines'} of this read ${n === 1 ? 'is' : 'are'}`
  const start = fill === 'back' ? lines.length - 1 : fill === 'forward' ? 0 : fill.around
  const sides = fill === 'back' ? 'older' : fill === 'forward' ? 'newer' : 'both'
  return fitWith(texts, start, sides, maxChars, (w) => ({
    ...(w.lo > 0 ? { older: JSON.stringify({ note: `${stopped}: ${many(w.lo, 'older')} not shown. read_session with before=${lines[w.lo]?.seq}${again} reads on, back from the oldest line shown.${hubNote(lines[w.lo]?.seq)}` }) } : {}),
    ...(w.hi < lines.length - 1 ? { newer: JSON.stringify({ note: `${stopped}: ${many(lines.length - 1 - w.hi, 'newer')} not shown. read_session with from=${lines[w.hi + 1]?.seq}${again} reads on, forward from the first line not shown.${hubNote(lines[w.hi + 1]?.seq)}` }) } : {}),
  }))
}

const isNote = (line: string | undefined): boolean => line?.startsWith('{"note":') === true

/**
 * The lines a linked machine answered a read with, bounded here when that machine did not (#1480: from before the
 * budget, it answers every line it has) or answered more than it was asked for. A plain read keeps the newest lines
 * that fit; one around a spot (`center`, the index the spot has in a machine's window) the lines nearest it, as the
 * machine's own reads do. The machine's notes at the ends stay and are counted. These lines carry no seq, so a note of
 * ours cannot name the read that goes on: it says to find the passage with recall and read around its seq
 */
export function fitMachineLines(lines: readonly string[], maxChars: number, center: number | null): string[] {
  if (lines.reduce((sum, l) => sum + l.length + 1, 0) <= maxChars) return [...lines]
  const head = isNote(lines[0]) ? lines.slice(0, 1) : []
  const tail = lines.length > head.length && isNote(lines[lines.length - 1]) ? lines.slice(-1) : []
  const body = lines.slice(head.length, lines.length - tail.length)
  const room = maxChars - [...head, ...tail].reduce((sum, l) => sum + l.length + 1, 0)
  const start = center === null ? body.length - 1 : Math.max(0, Math.min(center - head.length, body.length - 1))
  const how = 'That machine runs a Centralu from before the budget, so it cannot name the read that goes on: find the passage with recall and read around its seq, or update that machine'
  const note = (n: number, which: string) => JSON.stringify({ note: `Stopped at the ${maxChars}-character budget: ${n} ${which} ${n === 1 ? 'line' : 'lines'} of this read ${n === 1 ? 'is' : 'are'} not shown. ${how}` })
  const out = fitWith(body, start, center === null ? 'older' : 'both', Math.max(room, 1), (w) => ({
    ...(w.lo > 0 ? { older: note(w.lo, 'older') } : {}),
    ...(w.hi < body.length - 1 ? { newer: note(body.length - 1 - w.hi, 'newer') } : {}),
  }))
  return [...head, ...out, ...tail]
}

/**
 * The lines of a predecessor in the reader's handoff lineage, marked as its (#1487). The assistant's words become the
 * predecessor's (`role: predecessor`), so they cannot be taken for the reader's own, and every line names the session,
 * so none reads as the reader's conversation or as an instruction to it. What the person said to the predecessor stays
 * `user`, as a line of that session.
 */
export function asPredecessor(lines: readonly SessionLine[], sessionId: string): SessionLine[] {
  return lines.map((l) => {
    const { ts, role, ...rest } = l.fields
    return { seq: l.seq, fields: { ts, role: role === 'assistant' ? 'predecessor' : role, predecessor: sessionId, ...rest } }
  })
}
