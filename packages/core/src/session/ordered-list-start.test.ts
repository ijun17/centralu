import { describe, expect, it } from 'vitest'
import { startNumberedLists } from './ordered-list-start.js'

describe('startNumberedLists (#2242)', () => {
  it("puts a blank line before a list starting at 2 under a bold line (the issue's mail)", () => {
    const mail = '**#1324 Watches**\n2. Should every session be told ...\n   - A: ...\n3. Who watches the PR checks?'
    expect(startNumberedLists(mail)).toBe('**#1324 Watches**\n\n2. Should every session be told ...\n   - A: ...\n3. Who watches the PR checks?')
  })

  it('does it under a line of prose of any kind, for a `)` marker, and for `01.`, which CommonMark does not take as a 1', () => {
    expect(startNumberedLists('Questions:\n5) five')).toBe('Questions:\n\n5) five')
    expect(startNumberedLists('text\n01. one')).toBe('text\n\n01. one')
    // A line that only starts like a heading, a fence or HTML is prose
    expect(startNumberedLists('#1324 Watches\n2. x')).toBe('#1324 Watches\n\n2. x')
    expect(startNumberedLists('`foo()` returns:\n2. x')).toBe('`foo()` returns:\n\n2. x')
    expect(startNumberedLists('~~old~~ text\n2. x')).toBe('~~old~~ text\n\n2. x')
  })

  it('does it after a nested list that a blank line has ended, and for the second list of a reply', () => {
    expect(startNumberedLists('- a\n  - nested\n\n**More**\n2. two')).toBe('- a\n  - nested\n\n**More**\n\n2. two')
    expect(startNumberedLists('**A**\n2. a\n3. b\n\n**B**\n5. c')).toBe('**A**\n\n2. a\n3. b\n\n**B**\n\n5. c')
  })

  it('reads a year opening a line as CommonMark reads it at the start of a paragraph: a list', () => {
    expect(startNumberedLists('It was a year.\n2024. was the year')).toBe('It was a year.\n\n2024. was the year')
  })

  it('leaves a list starting at 1, an item after an item or its lazy lines, and a line under a blank line', () => {
    for (const text of ['**A**\n1. one', '1. one\n2. two\n3. three', '**A**\n\n2. two', '1. one\nlazy\n2. two', '1. one\n   - nested\n**More**\n2. two', '- a\nlazy\n2. two']) {
      expect(startNumberedLists(text)).toBe(text)
    }
  })

  it('leaves what is not prose above it, and an indented, quoted or too deeply indented line', () => {
    for (const text of ['# Title\n2. two', '---\n2. two', '| a | b |\n2. two', '> quote\n2. two', '<div>\n2. two', 'text\n    2. code', 'text\n> 2. quoted', '- item\n2. two', '- Sub\n   continued\n2. x']) {
      expect(startNumberedLists(text)).toBe(text)
    }
  })

  it('leaves a fenced block, an unclosed fence and a fence an info string does not close, and goes on after a closed one', () => {
    for (const text of ['```\ntext\n2. two\n```', '~~~\ntext\n2. two', '````\n```\ntext\n2. two\n````', '```\nA\n```js\nprose\n2. two\n```']) {
      expect(startNumberedLists(text)).toBe(text)
    }
    expect(startNumberedLists('```\ncode\n```\ntext\n2. two')).toBe('```\ncode\n```\ntext\n\n2. two')
    // Right under a fence the line is not under prose
    expect(startNumberedLists('```\ncode\n```\n2. two')).toBe('```\ncode\n```\n2. two')
  })

  it('leaves a line that is not a list line: no words after the marker, no space, ten digits', () => {
    for (const text of ['text\n2.', 'text\n2.5 percent', 'text\n1234567890. no', 'text\n2.x']) {
      expect(startNumberedLists(text)).toBe(text)
    }
  })

  it('gives the same text back when there is nothing to do', () => {
    const text = 'plain\ntext'
    expect(startNumberedLists(text)).toBe(text)
  })
})
