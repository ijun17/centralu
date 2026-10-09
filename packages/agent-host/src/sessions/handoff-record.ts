import type { StoredMessage } from '@cc/protocol'

/**
 * The handoff record (#78) — **a handoff with no summarizer**, and its result **is a file**
 * (#102).
 *
 * A live handoff has the dying agent write its own note (written as its reply, and the host lands
 * it as a file, #142). If the service is interrupted that path is blocked, but the raw
 * conversation is still fully present in our store with no compaction. This module materializes
 * that raw conversation into text a successor can read — deterministically, with no LLM.
 *
 * **It is no longer sized to fit one chat message** (#102). This file used to have a ladder: an
 * old reply got demoted to its first 500 characters, then the summary was shortened, and if it
 * still overflowed, material was dropped from the front. That ladder existed for exactly one
 * reason — the result used to be sent as a single initialPrompt. Now the host writes this text
 * into a note slot in the data folder (`<data>/handoff/<project id>/<session id>.md`, #142) and
 * the successor only receives the path. With no envelope to fit, there is no need for uniform
 * degradation either.
 *
 * **What actually takes up the space is measured** (#102): tool_result 45% + tool_call 43% = 88%.
 * What people said is only 8%. Each row is small (tool_result averages 0.6KB) and the problem is
 * **count**, so instead of trimming the body, **rows are collapsed** — in three tiers, most recent
 * first.
 *
 * **The boundary is stated explicitly.** Text degraded uniformly can look intact while it is not,
 * and the reader has no way to tell. So this fills from the most recent material up to the cap,
 * and the first line says how far it reaches. Cutting is justified because the raw material stays
 * intact in the store: this file is **a view, not a copy**, and a wider view can always be built
 * again.
 *
 * **The pivot is optional.** If there is a last compaction marker, material is filled from there
 * and the tool's own summary is placed above it. Measured: codex sessions used to have **zero**
 * compaction markers in our store — the marker came only from `thread/compacted`, which no measured
 * CLI sends (#303). Codex now leaves one from its `contextCompaction` item, but a session stored
 * before that, or a conversation imported from a tool whose record names no compaction, still has
 * none, so when there is none, only the recency cap is applied. Material is folded away only when
 * a summary exists, and a remote (encrypted) codex compaction has none (#267).
 */

/**
 * The byte cap on the record file. 2MB is measured as the size that fits the most recent tens of
 * thousands of rows out of a 200,000-row transcript, and it is also a size a person can search
 * through with `rg` with no strain. It is a **file** cap, not a message-envelope cap, so it limits
 * only disk and read cost, not context.
 */
export const RECORD_CAP = 2_000_000

/**
 * How many of the most recent tool calls carry their full result body verbatim.
 * 40 ≈ the predecessor's last couple of turns — the measured width of "what was on their mind."
 * (0.6KB average × 40 ≈ 25KB. Up to here is a range trustworthy enough not to need re-running.)
 */
const TOOLS_VERBATIM = 40
/**
 * How many before that are kept as a one-line trace.
 * 1,000 ≈ a day's work. One line is ~70B, so even 1,000 lines is 70KB, 3% of the cap — at this
 * value, the chronicle of "what was done to which file" is almost never cut off.
 */
const TOOLS_LINE = 1_000
/** The cap on how many file paths appear in the header/collapsed lines — a list that pushes out the body is not a list */
const TOUCHED_MAX = 60

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const num = (n: number) => n.toLocaleString('en-US')
const distinct = (xs: string[]) => [...new Set(xs)]

type ToolEntry = {
  kind: 'tool'
  seq: number
  tool: string
  title: string
  paths: string[]
  /** null means a call whose result has not landed yet (a session cut off mid-turn) */
  ok: boolean | null
  result: string
}
type TextEntry = { kind: 'text'; seq: number; text: string }
type Entry = ToolEntry | TextEntry

/** Rows to entries — reasoning, approvals and markers are dropped, since they are not for a successor to read */
function toEntries(rows: StoredMessage[]): Entry[] {
  const out: Entry[] = []
  // Match by callId so a tool_result lands on its own call entry
  const byCall = new Map<string, ToolEntry>()
  for (const r of rows) {
    const p = r.payload as { text?: string; callId?: string; ok?: boolean; summary?: unknown }
    if (r.kind === 'text') {
      const text = (p.text ?? '').trim()
      if (!text) continue
      out.push({ kind: 'text', seq: r.seq, text: `[${r.role}] ${text}` })
    } else if (r.kind === 'image') {
      out.push({ kind: 'text', seq: r.seq, text: '[user] (image attached)' })
    } else if (r.kind === 'tool_call') {
      const s = (p.summary ?? {}) as { tool?: string; title?: string; paths?: string[] }
      const e: ToolEntry = {
        kind: 'tool',
        seq: r.seq,
        tool: s.tool ?? '?',
        title: s.title ?? '',
        paths: s.paths ?? [],
        ok: null,
        result: '',
      }
      out.push(e)
      if (p.callId) byCall.set(p.callId, e)
    } else if (r.kind === 'tool_result') {
      const call = p.callId ? byCall.get(p.callId) : undefined
      if (call) {
        call.ok = p.ok !== false
        call.result = typeof p.summary === 'string' ? p.summary.trim() : ''
      }
    }
  }
  return out
}

const isTool = (e: Entry): e is ToolEntry => e.kind === 'tool'

/**
 * A one-line trace — `[38817] Edit packages/ui/src/store/store.ts (ok)`.
 * The seq at the start of the line does not get thousands separators: it is not a quantity to
 * count but **a name to search for**, and it must be searchable as-is by a person trying to pull
 * that row back out of the record.
 */
const toolLine = (e: ToolEntry) =>
  `[${e.seq}] ${e.tool}${e.title ? ` ${e.title}` : ''}${e.ok == null ? '' : e.ok ? ' (ok)' : ' (failed)'}`

const indent = (s: string) => s.replace(/^/gm, '    ')

/** The oldest tool group is counted and turned into one block — only the count and the touched files survive */
function collapsedLine(list: ToolEntry[]): string {
  const counts = new Map<string, number>()
  for (const e of list) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1)
  const kinds = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t} ×${num(n)}`)
    .join(', ')
  const paths = distinct(list.flatMap((e) => e.paths)).slice(0, TOUCHED_MAX)
  const where = paths.length ? ` — ${paths.join(', ')}` : ''
  return `[${list[0]!.seq}–${list[list.length - 1]!.seq}] ${num(list.length)} earlier tool calls (${kinds})${where}`
}

/** Most recently touched files first — the thing a successor looks for first, and computing it costs nothing extra */
function touchedPaths(entries: Entry[]): string[] {
  const seen: string[] = []
  for (let i = entries.length - 1; i >= 0 && seen.length < TOUCHED_MAX; i--) {
    const e = entries[i]!
    if (!isTool(e)) continue
    for (const p of e.paths) if (!seen.includes(p)) seen.push(p)
  }
  return seen.slice(0, TOUCHED_MAX)
}

export function buildHandoffRecord(opts: {
  name: string
  tool: string
  /** The tool the successor will use. Omit if unknown — the header then writes only the predecessor's tool, with no arrow */
  toTool?: string
  /** The tool's last compaction-summary text (from a codex rollout). null means no summary section */
  summary: string | null
  /** **All** of the session's rows, in time order — handling before and after the pivot happens here */
  rows: StoredMessage[]
  /** The seq of the last successful compaction marker. null means only the recency cap is applied, with no pivot */
  pivotSeq: number | null
  cap?: number
}): string {
  const cap = opts.cap ?? RECORD_CAP
  const all = toEntries(opts.rows)
  const lastSeq = opts.rows.length ? opts.rows[opts.rows.length - 1]!.seq : 0

  // Material before the pivot is only folded away **when there is a summary** — dropping it with no summary would leave that span nowhere at all
  const summary = opts.summary?.trim() || null
  const folded = summary != null && opts.pivotSeq != null
  const entries = folded ? all.filter((e) => e.seq > opts.pivotSeq!) : all

  /*
   * The three-tier fold. Only **tool entries** are counted for the tiers; what people said is
   * untouched at every tier — 88% of the volume is tools and 8% is speech, so trimming speech
   * would buy nothing.
   */
  const tools = entries.filter(isTool)
  const verbatimFrom = Math.max(0, tools.length - TOOLS_VERBATIM)
  const lineFrom = Math.max(0, verbatimFrom - TOOLS_LINE)
  const verbatim = new Set(tools.slice(verbatimFrom))
  const collapsing = tools.slice(0, lineFrom)
  const collapsed = new Set(collapsing)

  const rendered: { seq: number; text: string }[] = []
  let collapseWritten = false
  for (const e of entries) {
    if (!isTool(e)) {
      rendered.push({ seq: e.seq, text: e.text })
      continue
    }
    if (collapsed.has(e)) {
      // A collapsed group stands as one line at the spot it is first encountered — it must stay in time order to read correctly
      if (!collapseWritten) {
        collapseWritten = true
        rendered.push({ seq: e.seq, text: collapsedLine(collapsing) })
      }
      continue
    }
    const head = toolLine(e)
    rendered.push({ seq: e.seq, text: verbatim.has(e) && e.result ? `${head}\n${indent(e.result)}` : head })
  }

  const instructions = [
    `Your predecessor session "${opts.name}" (${opts.tool}) could not respond, so the app`,
    'built this record from its stored conversation. It is raw material, not a curated',
    'briefing — digest it yourself, then continue the work. Reply first with a short',
    'summary of your understanding of the current state. Match the language the',
    'conversation itself uses.',
    'Older tool calls appear as one-line traces: re-read files and re-run commands',
    'yourself instead of assuming their old output.',
    '',
  ].join('\n')
  const touched = touchedPaths(all)
  const touchedLine = touched.length ? `touched: ${touched.join(', ')}\n` : ''
  const summarySection = summary ? `## The tool's last compaction summary\n\n${summary}\n\n` : ''
  const verbatimMark = '── verbatim from here ──\n\n'

  /*
   * The cap is filled **starting from the most recent.** The rule is never to cut inside an
   * entry that is included — a half-cut entry would pretend to be intact, but a span dropped
   * entirely is announced by the first line.
   */
  const fixed = bytes(instructions + touchedLine + summarySection + verbatimMark) + 200 // slack for the covers line
  // A running total and one slice at the end: re-summing (or shifting) per dropped entry is
  // quadratic, and a long text-only transcript (hundreds of thousands of rows) would hold the
  // host's main thread for minutes.
  const sizes = rendered.map((e) => bytes(e.text) + 2)
  let size = sizes.reduce((n, s) => n + s, fixed)
  let dropped = 0
  while (size > cap && rendered.length - dropped > 1) {
    size -= sizes[dropped]!
    dropped++
  }
  const kept = rendered.slice(dropped)

  const from = kept.length ? kept[0]!.seq : lastSeq
  const covers =
    `covers seq ${num(from)}–${num(lastSeq)} of ${num(lastSeq)}` +
    ` · ${(cap / 1_000_000).toFixed(1)} MB cap` +
    (dropped > 0 || folded ? " · earlier material stays in the app's records" : '')
  const header = `# Handoff · ${opts.name} · ${opts.tool}${opts.toTool ? ` → ${opts.toTool}` : ''}\n${covers}\n${touchedLine}\n`

  return header + instructions + summarySection + verbatimMark + kept.map((e) => e.text).join('\n\n') + '\n'
}
