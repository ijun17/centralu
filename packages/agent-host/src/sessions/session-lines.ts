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

/** One line, before it is written out: its fields and the seq of its first message, where `around` finds it again */
export type SessionLine = { seq: number; fields: Record<string, unknown> }

/** Who wrote a line another session or an app sent (#838): a child's report or an app's text is not the person's */
function byWhom(payload: unknown): Record<string, string> {
  const author = authorOf(payload)
  return author.kind === 'session' ? { from: author.name } : author.kind === 'app' ? { fromApp: author.name } : {}
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ')

/**
 * The lines of these rows, in order. Two messages of one response are two paragraphs of one line, as `turnAnswer`
 * joins them (#428). **A tool call is folded up**: expanded, a full script or commit message buries the conversation
 * under it (a dogfooding finding); one line says what happened, and `tools` expands it when it is actually needed.
 */
export function sessionLines(rows: readonly StoredMessage[], opts: { tools?: boolean } = {}): SessionLine[] {
  const lines: SessionLine[] = []
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
    } else if (r.kind === 'tool_call' && p.summary?.title) {
      const title = opts.tools ? p.summary.title : p.summary.title.split('\n')[0]!.slice(0, 100)
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
 */
export function lineText(line: SessionLine, from = 0, max = LINE_MAX_CHARS): string {
  const key = typeof line.fields.text === 'string' ? 'text' : typeof line.fields.title === 'string' ? 'title' : null
  if (!key) return JSON.stringify(line.fields)
  const whole = line.fields[key] as string
  if (from === 0 && whole.length <= max) return JSON.stringify(line.fields)
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
