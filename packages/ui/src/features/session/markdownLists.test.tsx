import { renderToStaticMarkup } from 'react-dom/server'
import { startNumberedLists } from '@cc/core'
import { describe, expect, it } from 'vitest'
import { Markdown, MarkdownBlock } from './Markdown.jsx'
import { advanceSplit, piecesOf, type MarkdownSplit } from './markdownBlocks.js'

/*
 * #2242: a mail (and a reply) that numbers its questions under bold lines lost its numbers: CommonMark lets only a list
 * starting at 1 interrupt a paragraph, so `2.` stayed words in the bold line's paragraph. The numbers are drawn by `<ol start>`.
 */
const html = (text: string) => renderToStaticMarkup(<Markdown text={text} projectRoot={null} />)

describe('Markdown: a numbered list that starts above 1', () => {
  it("is a list after a bold line, with its nested list inside the item (the issue's mail)", () => {
    const out = html('**#1324 Watches**\n2. Should every session be told ...\n   - A: ...\n3. Who watches the PR checks?')
    expect(out).toContain('<p><strong>#1324 Watches</strong></p>')
    expect(out).toContain('<ol start="2">')
    expect(out).toMatch(/<li>Should every session be told \.\.\.\s*<ul>\s*<li>A: \.\.\.<\/li>\s*<\/ul>\s*<\/li>/)
    expect(out).toContain('<li>Who watches the PR checks?</li>')
    expect(out.match(/<ol/g)).toHaveLength(1)
    // What the repair leaves alone keeps its look: a list at 1, a tight list, code
    expect(html('**A**\n1. one')).toContain('<ol>')
    expect(html('1. one\n2. two')).not.toContain('<p>')
    expect(html('```\ntext\n2. two\n```')).toContain('text\n2. two')
  })

  it('is a list after a paragraph line, and after a nested list', () => {
    expect(html('Plain line\n5. five')).toContain('<ol start="5">')
    const out = html('- a\n  - nested\n\n**More**\n2. two')
    expect(out).toContain('<p><strong>More</strong></p>')
    expect(out).toContain('<ol start="2">')
    // The lazy line of a tight list is its own: the list stays tight
    expect(html('1. one\nlazy\n2. two')).not.toContain('<p>')
  })
})

describe('the repair while a reply streams', () => {
  it('draws at every point of the stream what one parse of the repaired text draws', () => {
    const reply = '**Questions**\n2. Should every session be told?\n   - A: yes\n3. Who watches?\n\nDone.\n\n**More**\n7) seven\n'
    const block = (t: string) => renderToStaticMarkup(<MarkdownBlock text={t} projectRoot={null} projectId={null} />)
    let split: MarkdownSplit | null = null
    for (let n = 1; n <= reply.length; n++) {
      const text = startNumberedLists(reply.slice(0, n))
      split = advanceSplit(split, text)
      expect(piecesOf(split).map(block).join('\n'), `after ${n} characters`).toBe(block(text))
    }
  })
})
