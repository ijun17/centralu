import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * A streaming reply split into closed blocks and the one still written (#364, docs/state-management.md §4).
 * Parsed whole per delta, a forty-paragraph reply was parsed forty times, and WebKit kept the high-water mark
 * (docs/spikes/2026-10-memory-heavy-store.md §3). CommonMark closes a top-level block once a whole line of the
 * next follows it. A link reference or GFM footnote definition reads backwards, so a reply with one is not split.
 * Blocks are found with react-markdown's own parser and plugins, and only when the new text has a line break.
 */
export type MarkdownSplit = {
  readonly text: string
  /** Each the source of one or more whole top-level blocks, from first line to first line */
  readonly blocks: readonly string[]
  readonly tailStart: number
  readonly scannedTo: number
  /** Holds a definition: rendered whole */
  readonly whole: boolean
}

const parser = unified().use(remarkParse).use(remarkGfm).freeze()

/** `[label]:` after any quote or list markers; a false match (in a code block) costs the split, never the rendering */
const DEFINITION = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*\[[^\]]*\]:/m

/** A text seen for the first time is not split: a reply read back from history is drawn once, as one parse */
export function wholeSplit(text: string): MarkdownSplit {
  return { text, blocks: [], tailStart: 0, scannedTo: text.length, whole: DEFINITION.test(text) }
}

/** Carried on from `prev` only when `text` extends it (a delta) */
export function advanceSplit(prev: MarkdownSplit | null, text: string): MarkdownSplit {
  if (!prev) return wholeSplit(text)
  if (prev.text === text) return prev
  if (!text.startsWith(prev.text) || prev.whole) return wholeSplit(text)
  if (DEFINITION.test(text.slice(prev.tailStart))) return wholeSplit(text)
  if (!text.includes('\n', prev.scannedTo)) return { ...prev, text }
  const { starts, children } = topLevel(text, prev.tailStart)
  const keep = closedUpTo(text, prev.tailStart, starts, children)
  if (keep === 0) return { ...prev, text, scannedTo: text.length }
  // One piece from where the last scan left off (blank lines before the first block belong to it) to the cut
  const blocks = [...prev.blocks, text.slice(prev.tailStart, starts[keep])]
  return { text, blocks, tailStart: starts[keep]!, scannedTo: text.length, whole: false }
}

/** Joined by a line break, as react-markdown joins top-level blocks, they render as the whole text does */
export function piecesOf(split: MarkdownSplit): string[] {
  return split.blocks.length ? [...split.blocks, split.text.slice(split.tailStart)] : [split.text]
}

type Block = ReturnType<typeof parser.parse>['children'][number]

/** Each block starts at its first line's start, not the node's: an indented list's continuation lines are measured against it */
function topLevel(text: string, from: number): { starts: number[]; children: Block[] } {
  const slice = text.slice(from)
  const starts: number[] = []
  const children: Block[] = []
  for (const child of parser.parse(slice).children) {
    const offset = child.position?.start.offset
    if (offset === undefined) break
    starts.push(from + slice.lastIndexOf('\n', offset - 1) + 1)
    children.push(child)
  }
  return { starts, children }
}

/**
 * How many leading blocks are closed for good and draw alone what they draw here. Until the next block's first line
 * is whole it can still continue this one (`1` under a list, then `1) `). micromark carries state past lists, quotes,
 * indented code and HTML (after indented code and a blank line `3. three` is a paragraph), so the cut is only after a
 * paragraph, heading, rule, table or fence and a blank line, and only if both sides parse alone as they did in place.
 * The randomized test in markdownBlocks.test.tsx turns up all three cases.
 */
function closedUpTo(text: string, from: number, starts: number[], children: Block[]): number {
  let keep = starts.length - 1
  if (keep > 0 && !text.includes('\n', starts[keep])) keep--
  for (; keep > 0; keep--) {
    const before = children[keep - 1]!
    const end = before.position?.end.offset
    if (end === undefined || !endsCleanly(before, text.slice(starts[keep - 1]))) continue
    if (!/\n[ \t]*\n/.test(text.slice(from + end, starts[keep]))) continue
    if (!sameBlocks(parser.parse(text.slice(starts[keep])).children, children.slice(keep))) continue
    if (sameBlocks(parser.parse(text.slice(from, starts[keep])).children, children.slice(0, keep))) return keep
  }
  return 0
}

/** A block that leaves nothing open behind it: `source` is the text from its first line on */
function endsCleanly(block: Block, source: string): boolean {
  if (block.type === 'code') return /^ {0,3}(`{3,}|~{3,})/.test(source)
  return block.type === 'paragraph' || block.type === 'heading' || block.type === 'thematicBreak' || block.type === 'table'
}

/** Equal trees, `position` left out */
function sameBlocks(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => k !== 'position')
  const kb = Object.keys(b).filter((k) => k !== 'position')
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameBlocks((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
