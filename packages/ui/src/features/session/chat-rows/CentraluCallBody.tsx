import { useMemo } from 'react'
import { isRecord } from '@cc/protocol/client'
import { Markdown } from '../Markdown.jsx'

/** How many rows a closed card shows before "N more" */
const CLOSED_ROWS = 3

type Row = Record<string, unknown>

/**
 * What a call to Centralu's own tools answered, drawn for a person (owner, 2026-10-18: it was raw JSON).
 *
 * The answer's shape decides the drawing, not the tool's name, so a tool that changes its words keeps working:
 *  - one JSON object per line with a `role` (read_session's transcript): a small conversation, who said what;
 *  - one JSON object per line, or a JSON array of objects (lists of sessions, hits, apps): a list, each row its main
 *    words first and the rest as quiet key: value pairs;
 *  - one JSON object: its fields as key: value lines;
 *  - anything else: the text as Markdown (start_agent's sentence, app_guide's guide).
 * Closed, a card shows the first rows and how many more; open, all of them.
 */
export function CentraluCallBody({ result, open, onOpen }: { result: string; open: boolean; onOpen: () => void }) {
  const shape = useMemo(() => readShape(result), [result])
  if (shape.kind === 'text') {
    return (
      <div className={`text-sm leading-body text-ink-muted [&_.cc-md]:text-sm ${open ? '' : 'line-clamp-4'}`} data-testid="centralu-call-text">
        <Markdown text={shape.text} projectRoot={null} />
      </div>
    )
  }
  if (shape.kind === 'fields') {
    return <Fields row={shape.row} />
  }
  const rows = open ? shape.rows : shape.rows.slice(0, CLOSED_ROWS)
  const more = shape.rows.length - rows.length
  return (
    <div data-testid={shape.kind === 'transcript' ? 'centralu-call-transcript' : 'centralu-call-list'}>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r, i) => (shape.kind === 'transcript' ? <TranscriptRow key={i} row={r} /> : <ListRow key={i} row={r} />))}
      </ul>
      {more > 0 && (
        <button type="button" className="readout mt-1.5 text-2xs text-ink-faint transition-colors hover:text-ink" onClick={onOpen} data-testid="tool-card-more">
          {more} more
        </button>
      )}
    </div>
  )
}

type Shape = { kind: 'text'; text: string } | { kind: 'fields'; row: Row } | { kind: 'transcript' | 'list'; rows: Row[] }

export function readShape(result: string): Shape {
  const text = result.trim()
  try {
    const whole: unknown = JSON.parse(text)
    if (Array.isArray(whole) && whole.length > 0 && whole.every(isRecord)) return listOrTranscript(whole)
    if (isRecord(whole)) {
      // An object that wraps its list (`{ sessions: [...] }`) is that list
      const lists = Object.values(whole).filter((v) => Array.isArray(v) && v.length > 0 && v.every(isRecord)) as Row[][]
      if (lists.length === 1 && Object.keys(whole).length <= 2) return listOrTranscript(lists[0]!)
      return { kind: 'fields', row: whole }
    }
  } catch {
    // not one JSON value: maybe one per line
  }
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length > 0 && lines.every((l) => l.trim().startsWith('{'))) {
    try {
      const rows = lines.map((l) => JSON.parse(l) as unknown)
      if (rows.every(isRecord)) return listOrTranscript(rows)
    } catch {
      // a line that is not JSON: the whole is text
    }
  }
  return { kind: 'text', text }
}

const listOrTranscript = (rows: Row[]): Shape => (rows.every((r) => typeof r.role === 'string') ? { kind: 'transcript', rows } : { kind: 'list', rows })

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** One line of a session's conversation: who, when, and what they said or ran */
function TranscriptRow({ row }: { row: Row }) {
  const role = str(row.role)
  const who = role === 'user' ? str(row.from) || 'person' : role === 'assistant' ? 'agent' : role
  const ts = str(row.ts)
  const body = str(row.text) || [str(row.tool), str(row.title)].filter(Boolean).join(' · ')
  const isTool = !row.text && (row.tool || row.title)
  return (
    <li className="flex gap-2.5 text-xs" data-role={role}>
      <span className="readout w-14 shrink-0 truncate pt-px text-2xs text-ink-faint" title={ts}>
        {who}
      </span>
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words leading-body ${isTool ? 'readout text-2xs text-ink-faint' : role === 'user' ? 'text-ink' : 'text-ink-muted'}`}>
        {body.length > 600 ? `${body.slice(0, 600)}…` : body}
      </span>
    </li>
  )
}

/** The words a row is known by, first of the fields that usually carry them */
const TITLE_KEYS = ['name', 'title', 'text', 'label', 'summary', 'id']

/** One item of a list: its name, then the other short fields quietly */
function ListRow({ row }: { row: Row }) {
  const key = TITLE_KEYS.find((k) => typeof row[k] === 'string' && row[k])
  const title = key ? str(row[key]) : ''
  const rest = Object.entries(row).filter(([k, v]) => k !== key && v !== null && v !== undefined && str(v).length <= 80)
  return (
    <li className="min-w-0 rounded-md bg-surface-hover/20 px-2.5 py-1.5">
      {title && <span className="block truncate text-xs text-ink">{title}</span>}
      {rest.length > 0 && (
        <span className="readout mt-0.5 block truncate text-2xs text-ink-faint">
          {rest.map(([k, v]) => `${k} ${str(v)}`).join(' · ')}
        </span>
      )}
    </li>
  )
}

/** One object's fields as key: value lines */
function Fields({ row }: { row: Row }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs" data-testid="centralu-call-fields">
      {Object.entries(row).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="readout text-2xs text-ink-faint">{k}</dt>
          <dd className="min-w-0 truncate text-ink-muted" title={str(v)}>
            {str(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}
