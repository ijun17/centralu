import { describe, expect, it } from 'vitest'
import { DIFF_PREVIEW_CHARS, lineDiff } from './file-changes.js'

describe('the diff of an edit given as the whole text before and after', () => {
  it('keeps a change deep in a long file on the card, with two lines around it', () => {
    const file = (changed: string) => Array.from({ length: 400 }, (_, i) => (i === 200 ? changed : `line ${i} of the file`)).join('\n') + '\n'
    const diff = lineDiff(file('old'), file('new'))
    expect(diff).toBe([' line 198 of the file', ' line 199 of the file', '-old', '+new', ' line 201 of the file', ' line 202 of the file'].join('\n'))
    // Listing every old line before every new one would cut the new text off the card
    expect(DIFF_PREVIEW_CHARS).toBeLessThan(file('old').length)
  })

  it('shows a new file as what it writes, and a deleted one as what it held', () => {
    expect(lineDiff(null, 'a\nb\n')).toBe('+a\n+b')
    expect(lineDiff(undefined, 'a')).toBe('+a')
    expect(lineDiff('a\nb\n', '')).toBe('-a\n-b')
  })

  it('reads the pseudo headers Cursor sends for a new file as unified-diff headers, and a delete as the path it removes', () => {
    expect(lineDiff('-- /dev/null', '++ b/notes.txt\nhi')).toBe('--- /dev/null\n+++ b/notes.txt\n+hi')
    expect(lineDiff('/work/gone.txt', '')).toBe('-/work/gone.txt')
  })

  it('shows nothing for a change that changes nothing', () => {
    expect(lineDiff('same\n', 'same\n')).toBe('')
  })
})
