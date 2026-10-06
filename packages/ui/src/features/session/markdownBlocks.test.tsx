import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownBlock } from './Markdown.jsx'
import { advanceSplit, piecesOf, wholeSplit, type MarkdownSplit } from './markdownBlocks.js'

/*
 * A streamed reply is drawn in pieces (#364): the blocks that can no longer change, each rendered once, and the one
 * still being written. These tests hold the pieces to what one parse of the same text draws, at every point of a
 * stream, over random cuts of replies built to put every block kind next to every other.
 */

const render = (text: string) => renderToStaticMarkup(<MarkdownBlock text={text} projectRoot={null} projectId={null} />)
/** What `Markdown` draws for a split: the pieces, each rendered alone, joined as the component joins them */
const renderPieces = (split: MarkdownSplit) => piecesOf(split).map(render).join('\n')

/** A small deterministic generator, so a failure names the seed that made it */
function rng(seed: number) {
  let a = seed >>> 0 || 1
  return () => {
    a ^= a << 13
    a ^= a >>> 17
    a ^= a << 5
    return (a >>> 0) / 4294967296
  }
}

/** Cuts `text` into deltas of 1 to `max` characters, as a model's stream arrives */
function cuts(text: string, random: () => number, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(random() * max)
    out.push(text.slice(i, i + n))
    i += n
  }
  return out
}

/** Streams `text` through `advanceSplit` delta by delta, calling `each` with every split on the way */
function stream(text: string, deltas: string[], each?: (split: MarkdownSplit, sofar: string) => void): MarkdownSplit {
  let split: MarkdownSplit | null = null
  let sofar = ''
  for (const d of deltas) {
    sofar += d
    split = advanceSplit(split, sofar)
    each?.(split, sofar)
  }
  expect(sofar).toBe(text)
  return split!
}

/** Blocks a model writes, including the ones whose end depends on what follows them */
const BLOCKS = [
  'A plain paragraph with **bold**, _emphasis_, `code` and a [link](https://example.com).',
  'A paragraph\nthat runs over\ntwo line breaks.',
  '# A heading',
  '### A smaller heading with `code`',
  'Setext heading\n==============',
  'Another setext\n---',
  '```ts\nconst a = 1\n\nconst b = 2\n```',
  '~~~\nfence with ``` inside\n\n```\nstill inside\n~~~',
  '```\nan unclosed fence at the end',
  '    indented code\n\n    after a blank line',
  '- one\n- two\n- three',
  '- loose one\n\n- loose two\n\n- loose three',
  '1. first\n2. second\n   continued\n3. third',
  '3. starts at three\n4. four',
  '- outer\n  - inner\n    - innermost\n  - inner two\n- outer two',
  '  - indented by two\n    continued under it\n\n    a paragraph in the item',
  '- [ ] a task\n- [x] a done task',
  '| a | b |\n|---|:-:|\n| 1 | 2 |\n| x \\| y | `z` |',
  '| only header |\n| --- |',
  '> a quote\n> - with a list\n> - in it',
  '> a quote\nwith a lazy line',
  '---',
  '***',
  '<!-- a comment\n\nspanning a blank line -->',
  '<div>\nhtml block\n</div>',
  'A line with a hard break  \nand the next.',
  'Text with an autolink https://example.com/path and ~~strike~~.',
  'Ends with a colon:',
  '1) parenthesis list\n2) two',
  '* star list\n\n  with a paragraph\n\n* second',
  '+ plus list\n+ two',
  '- an item with code:\n\n  ```sh\n  pnpm verify\n\n  echo done\n  ```\n- next item',
  '> quoted code:\n> ```\n> a\n>\n> b\n> ```',
  '> > nested quote\n> back to one',
  '<pre>\npre block\n\nwith a blank line\n</pre>',
  '<!-- an unclosed comment',
  '## Closed heading ##',
  'A paragraph\n1. that a list interrupts\n2. two',
  'A paragraph\n| a | b |\n| - | - |\n| 1 | 2 |',
  'Tabs\tinside\tand a\ttrailing tab\t',
  'Line with spaces only below\n   \nand text after',
  '1. one\n\n   indented paragraph in the item\n\n       code in the item',
  'CRLF paragraph\r\nsecond line\r\n\r\n- crlf list\r\n- two',
  '[an inline link spanning\ntwo lines](https://example.com)',
  '**strong that starts\n\nand never closes',
]

/** Joins random blocks with random separators, so every kind lands directly after every other, blank line or not */
function randomReply(random: () => number, count: number): string {
  const seps = ['\n\n', '\n\n', '\n', '\n\n\n']
  let out = ''
  for (let i = 0; i < count; i++) {
    if (i) out += seps[Math.floor(random() * seps.length)]
    out += BLOCKS[Math.floor(random() * BLOCKS.length)]
  }
  return out
}

describe('a streamed reply drawn in pieces', () => {
  it('draws what one parse draws at every point of the stream, over random replies and random cuts', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed)
      const text = randomReply(random, 4 + Math.floor(random() * 6))
      stream(text, cuts(text, random, 24), (split, sofar) => {
        expect(renderPieces(split), `seed ${seed}, after ${JSON.stringify(sofar)}`).toBe(render(sofar))
      })
    }
  })

  it('ends identical to one parse of the whole reply, over many more random cuts', () => {
    for (let seed = 100; seed < 400; seed++) {
      const random = rng(seed)
      const text = randomReply(random, 6 + Math.floor(random() * 10))
      const split = stream(text, cuts(text, random, 1 + Math.floor(random() * 60)))
      expect(renderPieces(split), `seed ${seed}`).toBe(render(text))
    }
  })

  it('keeps a code fence whole while blank lines inside it arrive, and splits after it closes', () => {
    const text = 'Before.\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nAfter.\n'
    const seen: string[][] = []
    const split = stream(text, cuts(text, rng(7), 3), (s) => seen.push(piecesOf(s)))
    // No piece ever ends inside the fence
    for (const pieces of seen)
      for (const p of pieces.slice(0, -1)) expect((p.match(/```/g) ?? []).length % 2, JSON.stringify(pieces)).toBe(0)
    expect(piecesOf(split)).toEqual(['Before.\n\n', '```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n', 'After.\n'])
  })

  it('keeps a loose list one list, so its items keep their paragraphs, and cuts only after a block that ends cleanly', () => {
    const text = '- one\n\n- two\n\n- three\n\nAfter the list.\n\nMore.\n'
    const split = stream(text, cuts(text, rng(3), 2))
    expect(piecesOf(split)).toEqual(['- one\n\n- two\n\n- three\n\nAfter the list.\n\n', 'More.\n'])
    expect(renderPieces(split)).toBe(render(text))
  })

  it('draws what one parse draws where micromark carries state from one block into the next', () => {
    for (const text of [
      // After indented code, `3.` is a paragraph in place and a list alone
      'Text.\n\n    indented code\n\n\n3. starts at three\n4. four\n\nEnd.\n',
      // After a quote ending in a fence, indented code split by a blank line is two blocks in place and one alone
      'Text.\n\n> quoted code:\n> ```\n> a\n> ```\n    indented code\n\n    after a blank line\n\nEnd.\n',
    ]) {
      for (let seed = 1; seed <= 20; seed++)
        stream(text, cuts(text, rng(seed), 1 + (seed % 5)), (split, sofar) => {
          expect(renderPieces(split), `seed ${seed}, after ${JSON.stringify(sofar)}`).toBe(render(sofar))
        })
    }
  })

  it('does not split a reply with a link reference or footnote definition, which reaches back to earlier blocks', () => {
    for (const text of [
      'See [the docs][d].\n\nMore text.\n\n[d]: https://example.com',
      'A claim.[^1]\n\nAnother paragraph.\n\n[^1]: The source.',
      '- item with [a ref][r]\n\n- second\n\n  [r]: https://example.com/r',
      '> quoted [ref][q]\n\nnext\n\n> [q]: https://example.com/q',
    ]) {
      const split = stream(text, cuts(text, rng(11), 4))
      expect(renderPieces(split), text).toBe(render(text))
      expect(piecesOf(split)).toEqual([text])
    }
  })

  it('keeps the finished blocks of a long reply and parses only what follows them', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some **bold** words in it.`)
    const text = paragraphs.join('\n\n') + '\n'
    let last: MarkdownSplit | null = null
    const split = stream(text, cuts(text, rng(5), 12), (s) => {
      // A finished block is never taken back or changed: every later split starts with the same blocks
      if (last) expect(s.blocks.slice(0, last.blocks.length)).toEqual(last.blocks)
      last = s
    })
    expect(split.blocks).toHaveLength(39)
    expect(split.text.slice(split.tailStart)).toBe('Paragraph 39 with some **bold** words in it.\n')
  })

  it('starts over when the text is not a continuation of what was drawn', () => {
    const a = advanceSplit(advanceSplit(null, 'One.'), 'One.\n\nTwo.\n\nThree.\n')
    expect(a.blocks.length).toBeGreaterThan(0)
    const b = advanceSplit(a, 'Something else entirely.')
    expect(b).toEqual(wholeSplit('Something else entirely.'))
  })

  it('draws a reply seen whole for the first time as one piece', () => {
    const text = BLOCKS.join('\n\n')
    expect(piecesOf(advanceSplit(null, text))).toEqual([text])
  })
})
