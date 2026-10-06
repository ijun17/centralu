import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * A streaming reply split into the blocks that can no longer change and the one that still can (#364).
 *
 * Every `message_delta` used to hand the whole reply to react-markdown, which parsed it from the first character
 * again: a reply of forty paragraphs was parsed forty times over while its last one arrived. Chromium showed none of
 * that survives a collection; WebKit kept its high-water mark (docs/spikes/2026-10-memory-heavy-store.md §3).
 *
 * CommonMark reads a reply line by line, and a top-level block that a whole line of another top-level block has
 * followed is closed: text appended later cannot reopen it, and parsing from the line where the next block starts
 * gives what parsing the whole text gives there. So once a block has such a successor, it is rendered on its own and
 * kept; only the text from the last kept block on is parsed per delta. Two things in Markdown do reach backwards, and
 * a reply with either is not split at all: a link reference definition (`[x]: url`, which an earlier `[text][x]`
 * reads) and a GFM footnote definition (`[^1]: …`, which numbers the calls above it and is gathered at the end).
 *
 * The blocks are found with the same parser and plugins react-markdown uses, so where a block ends is decided by the
 * Markdown that renders it, not by a guess at fences, lists and tables. That parse runs only when the new text holds
 * a line break, since no line is whole without one, and only over the text after the last kept block.
 */
export type MarkdownSplit = {
  /** The text this split is of */
  readonly text: string
  /** Finished pieces, each the source text of one or more whole top-level blocks, from first line to first line */
  readonly blocks: readonly string[]
  /** Where the text still being written starts: `text.slice(tailStart)` */
  readonly tailStart: number
  /** How far the text has been looked at for new blocks */
  readonly scannedTo: number
  /** The text reaches backwards (a definition): rendered whole, never split */
  readonly whole: boolean
}

const parser = unified().use(remarkParse).use(remarkGfm).freeze()

/**
 * A link reference or footnote definition: `[label]:` at the start of a line, after any quote markers, list markers
 * and indentation (it may sit in a list item or a quote). A label may run over a line break. Text that only looks
 * like one (an indented `[key]: value` in a code block) costs the split, never the rendering.
 */
const DEFINITION = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*\[[^\]]*\]:/m

/** A text seen for the first time is not split: a reply read back from history is drawn once, as one parse */
export function wholeSplit(text: string): MarkdownSplit {
  return { text, blocks: [], tailStart: 0, scannedTo: text.length, whole: DEFINITION.test(text) }
}

/**
 * The split of `text`, carried on from `prev` when `text` only extends it (a delta arrived). Anything else (another
 * message in the same row, an edit) starts over from `wholeSplit`.
 */
export function advanceSplit(prev: MarkdownSplit | null, text: string): MarkdownSplit {
  if (!prev) return wholeSplit(text)
  if (prev.text === text) return prev
  if (!text.startsWith(prev.text) || prev.whole) return wholeSplit(text)
  if (DEFINITION.test(text.slice(prev.tailStart))) return wholeSplit(text)
  // A block is closed by a whole line of its successor (`closedUpTo`): with no new line break, nothing closed
  if (!text.includes('\n', prev.scannedTo)) return { ...prev, text }
  const { starts, children } = topLevel(text, prev.tailStart)
  const keep = closedUpTo(text, prev.tailStart, starts, children)
  if (keep === 0) return { ...prev, text, scannedTo: text.length }
  // One piece from where the last scan left off (blank lines before the first block belong to it) to the cut
  const blocks = [...prev.blocks, text.slice(prev.tailStart, starts[keep])]
  return { text, blocks, tailStart: starts[keep]!, scannedTo: text.length, whole: false }
}

/**
 * What is drawn, in order: the finished blocks, then the text still being written; the whole text as one piece when
 * nothing is split. Joined with a line break between pieces, as react-markdown joins top-level blocks, they render to
 * what the whole text renders to.
 */
export function piecesOf(split: MarkdownSplit): string[] {
  return split.blocks.length ? [...split.blocks, split.text.slice(split.tailStart)] : [split.text]
}

type Block = ReturnType<typeof parser.parse>['children'][number]

/**
 * The top-level blocks of `text.slice(from)`, and where each starts, as the offset of the start of its first line.
 * The start of the line rather than of the node: a list indented by a space or two keeps its indentation, which its
 * continuation lines are measured against.
 */
function topLevel(text: string, from: number): { starts: number[]; children: Block[] } {
  const slice = text.slice(from)
  const starts: number[] = []
  const children: Block[] = []
  for (const child of parser.parse(slice).children) {
    const offset = child.position?.start.offset
    // A node without a position cannot be placed; the text from the last known start stays one piece
    if (offset === undefined) break
    starts.push(from + slice.lastIndexOf('\n', offset - 1) + 1)
    children.push(child)
  }
  return { starts, children }
}

/**
 * How many of the leading blocks can be kept: closed for good, and drawing alone what they draw here. 0 for none.
 *
 * A block is closed only once the first line of the block after it is whole. Until then that line can still turn
 * into a continuation of it: `1` under a list is a paragraph, and `1) ` a moment later is the list's next item. A
 * whole line is read once and for all, as CommonMark reads lines.
 *
 * And micromark does not start afresh at every block. After indented code and a blank line it reads `3. three` as a
 * paragraph, where alone it is a list starting at 3; after a quote that ends in a fence, indented code split by a
 * blank line comes out as two blocks, where alone it is one. Lists, quotes, indented code and HTML carry state into
 * the lines after them like this, so the text is only cut after a block that ends cleanly (a paragraph, a heading, a
 * rule, a table or a fenced code block) and is followed by a blank line; the blocks in between stay with the next
 * cut. Then what is about to be kept and what will be the tail are each parsed alone, and the cut is made only if they
 * parse to what they parsed to in place. That is two parses when a block is kept, not per delta. All three cases were
 * found by the randomized test in markdownBlocks.test.tsx.
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

/** The same Markdown tree, wherever in the text it was parsed from: `position` is the only thing left out */
function sameBlocks(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => k !== 'position')
  const kb = Object.keys(b).filter((k) => k !== 'position')
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameBlocks((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
