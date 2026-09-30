import { describe, expect, it } from 'vitest'
import { appendPath, hasDragFiles, hasDragPath, isFileDrag, PATH_MIME } from './dragPath.js'
import { PROJECT_MIME, SESSION_MIME } from '../sidebar/reorder.js'

/**
 * Drag-and-drop and `@` autocomplete must produce the same result —
 * with two ways to insert it, a different sentence would mean the tool receives something different.
 */
describe('appendPath', () => {
  it('attaches directly to an empty composer', () => {
    expect(appendPath('', 'src/a.ts')).toBe('@src/a.ts ')
  })

  it('inserts a space after existing text — running together with the preceding word would stop it from being a path', () => {
    expect(appendPath('take a look at this', 'src/a.ts')).toBe('take a look at this @src/a.ts ')
  })

  it('does not add another space if it already ends in whitespace', () => {
    expect(appendPath('take a look at this ', 'src/a.ts')).toBe('take a look at this @src/a.ts ')
    expect(appendPath('line break\n', 'src/a.ts')).toBe('line break\n@src/a.ts ')
  })

  it('chains together across multiple drops', () => {
    const one = appendPath('', 'a.ts')
    expect(appendPath(one, 'b.ts')).toBe('@a.ts @b.ts ')
  })

  it('leaves a trailing space — typing must be able to continue right after the drop', () => {
    expect(appendPath('', 'a.ts').endsWith(' ')).toBe(true)
  })
})

/**
 * Tells apart what is being dragged **before ever opening its content** (#19).
 *
 * During `dragover`, `getData()` returns an empty string — the browser hides the content until it is
 * actually dropped. So "can this spot accept it" and "if accepted, is it a move or a copy" have to be
 * answered by looking only at `types`. Doing this through `getData` instead would make the tree a
 * place whose cursor always says "cannot drop here," and that would only ever surface as nothing
 * happening, with no error.
 */
describe('what is being dragged', () => {
  const dt = (types: string[]) => ({ types }) as unknown as DataTransfer

  it('recognizes something dragged from the tree by our own MIME type', () => {
    expect(hasDragPath(dt([PATH_MIME, 'text/plain']))).toBe(true)
    expect(hasDragFiles(dt([PATH_MIME, 'text/plain']))).toBe(false)
  })

  it('recognizes a file dragged from the OS by Files', () => {
    expect(hasDragFiles(dt(['Files']))).toBe(true)
    expect(hasDragPath(dt(['Files']))).toBe(false)
  })

  it('accepts neither when it is neither (e.g. dragging selected text)', () => {
    expect(hasDragPath(dt(['text/plain']))).toBe(false)
    expect(hasDragFiles(dt(['text/plain']))).toBe(false)
  })
})

/**
 * Making the whole session panel a drop target (#116) ended up with **two kinds of dragging** on the
 * same surface: a drag meant to attach a file, and a drag meant to reorder a panel, session or
 * project.
 *
 * If the distinction were tied to DOM events, confirming the promise "reordering is never swallowed"
 * would require launching a browser. Here it is settled with a single types array.
 */
describe('is this a drag the panel should accept', () => {
  it('accepts a file dragged from the OS', () => {
    expect(isFileDrag(['Files'])).toBe(true)
  })

  it('also accepts a path dragged from the tree — it goes into the sentence rather than becoming an attachment, but the spot that answers it is the same', () => {
    expect(isFileDrag([PATH_MIME, 'text/plain'])).toBe(true)
  })

  it('lets reordering pass through — that drop has its own separate owner', () => {
    expect(isFileDrag([SESSION_MIME])).toBe(false)
    expect(isFileDrag([PROJECT_MIME])).toBe(false)
  })

  it('does not accept an unrecognized drag (e.g. dragging selected text)', () => {
    expect(isFileDrag(['text/plain'])).toBe(false)
    expect(isFileDrag([])).toBe(false)
  })

  it('accepts it as a file even with other types riding along — the OS carries text/uri-list alongside it', () => {
    expect(isFileDrag(['Files', 'text/uri-list', 'text/plain'])).toBe(true)
  })
})
