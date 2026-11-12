import { describe, expect, it } from 'vitest'
import { plainLine, plainLines } from './plain-line.js'

describe('a message body as one plain line (#2228)', () => {
  it('drops emphasis, code, link and image marks and keeps their words', () => {
    expect(plainLine('**배경** and *this* and __that__ and ~~gone~~ and `code` and [a link](https://x.test/y) and ![shot](a.png)', 200)).toBe('배경 and this and that and gone and code and a link and shot')
  })

  it('drops a line’s own marks: heading, quote, bullet, number, task box and fence', () => {
    expect(plainLine('# Title\n> quoted\n- one\n1. two\n- [x] three\n```ts\nlet a = 1', 200)).toBe('Title quoted one two three ts let a = 1')
  })

  it('keeps what only looks like a mark: snake_case, 2 * 3 and a lone star', () => {
    expect(plainLine('set max_retry_count to 2 * 3 * 4 and rate*', 200)).toBe('set max_retry_count to 2 * 3 * 4 and rate*')
  })

  it('cuts after the marks are gone, on one line', () => {
    expect(plainLine('**abcdefghij**\nklm', 5)).toBe('abcde…')
  })
})

describe('the first lines of a body for a card (#2229)', () => {
  it('keeps the lines as plain words, drops empty ones and cuts to the lines and characters given', () => {
    expect(plainLines('**Which** branch?\n\n- main\n- release\nand more', 3, 100)).toBe('Which branch?\nmain\nrelease')
    expect(plainLines('abcdefghij', 3, 5)).toBe('abcde…')
  })
})
