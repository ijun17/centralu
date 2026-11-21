import { describe, expect, it } from 'vitest'
import {
  appendPath,
  hasDragFiles,
  hasDragPath,
  INTERNAL_DRAG_MIME,
  isFileDrag,
  isInternalDrag,
  isOsFileDrag,
  markInternalDrags,
  PATH_MIME,
} from './dragPath.js'
import { APP_MIME, PANEL_MIME, PROJECT_MIME, SESSION_MIME } from '../sidebar/reorder.js'
import { PANEL_TAB_MIME } from '../../store/panelLayout.js'

// A drop and `@` autocomplete must give the tool the same sentence
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

// By `types` alone (#19): `getData()` is empty during `dragover`, so a check through it would refuse every drop silently
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

// The session panel (#116) shares its surface with reordering drags; a types array settles which it takes, no browser needed
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

// #286: WebKit adds a dragged grid panel's screenshots as `Files`, which must not attach to the panel it lands on
describe('a drag that started inside the app is never a file from the OS', () => {
  const dt = (types: string[]) => ({ types }) as unknown as DataTransfer

  it('does not take a session, panel, project, panel tab or app drag for a file, even with Files riding along', () => {
    for (const own of [SESSION_MIME, PANEL_MIME, PROJECT_MIME, PANEL_TAB_MIME, APP_MIME]) {
      const types = [own, 'Files']
      expect(isFileDrag(types), own).toBe(false)
      expect(isOsFileDrag(types), own).toBe(false)
      expect(hasDragFiles(dt(types)), own).toBe(false)
    }
  })

  it('does not take a marked drag for a file — the drags no handler of ours sets a type on, such as an image or selected text', () => {
    expect(isFileDrag([INTERNAL_DRAG_MIME, 'text/plain', 'Files'])).toBe(false)
    expect(hasDragFiles(dt([INTERNAL_DRAG_MIME, 'Files']))).toBe(false)
  })

  it('still takes a plain OS file, and a file-tree path even though that started inside the app', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isOsFileDrag(['Files'])).toBe(true)
    expect(isFileDrag([PATH_MIME, INTERNAL_DRAG_MIME, 'text/plain'])).toBe(true)
  })

  it('marks every drag that starts in the window, in the capture phase, until stopped', () => {
    type Listener = { type: string; fn: (e: DragEvent) => void; capture: boolean }
    const listeners: Listener[] = []
    const win = {
      addEventListener: (type: string, fn: Listener['fn'], o: { capture: boolean }) =>
        listeners.push({ type, fn, capture: o.capture }),
      removeEventListener: (type: string, fn: Listener['fn']) =>
        listeners.splice(
          listeners.findIndex((l) => l.type === type && l.fn === fn),
          1,
        ),
    } as unknown as Window
    const stop = markInternalDrags(win)
    expect(listeners).toEqual([expect.objectContaining({ type: 'dragstart', capture: true })])

    const data = new Map<string, string>()
    const e = { dataTransfer: { setData: (t: string, v: string) => data.set(t, v) } } as unknown as DragEvent
    listeners[0]!.fn(e)
    expect(isInternalDrag([...data.keys()])).toBe(true)
    expect(isFileDrag([...data.keys(), 'Files'])).toBe(false)

    stop()
    expect(listeners).toEqual([])
  })
})
