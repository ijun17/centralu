import { describe, expect, it } from 'vitest'
import { createLoader, loadErrorText, type Loaded } from './useLoad.js'

/** A loader whose screen is a variable, and questions answered by hand */
function harness<T>() {
  let shown: Loaded<T> = { data: undefined, error: null, loading: false }
  const loader = createLoader<T>((update) => {
    shown = update(shown)
  })
  const asked: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = []
  const ask = () => new Promise<T>((resolve, reject) => asked.push({ resolve, reject }))
  return { loader, ask, asked, shown: () => shown }
}

describe('createLoader (#850 item 8)', () => {
  it('shows the answer once it arrives, and loading until then', async () => {
    const h = harness<string[]>()
    const done = h.loader.read(h.ask, false)
    expect(h.shown()).toEqual({ data: undefined, error: null, loading: true })
    h.asked[0]!.resolve(['a.ts'])
    await done
    expect(h.shown()).toEqual({ data: ['a.ts'], error: null, loading: false })
  })

  it('a failed read is an error, never an empty answer', async () => {
    const h = harness<string[]>()
    const done = h.loader.read(h.ask, false)
    h.asked[0]!.reject(new Error('the host did not answer'))
    await expect(done).resolves.toBeUndefined()
    expect(h.shown()).toEqual({ data: undefined, error: 'the host did not answer', loading: false })
  })

  it('a refresh keeps the last answer on screen until the new one, a new subject does not', async () => {
    const h = harness<string>()
    const first = h.loader.read(h.ask, false)
    h.asked[0]!.resolve('alpha')
    await first
    void h.loader.read(h.ask, true)
    expect(h.shown()).toEqual({ data: 'alpha', error: null, loading: true })
    void h.loader.read(h.ask, false)
    expect(h.shown()).toEqual({ data: undefined, error: null, loading: true })
  })

  it('a failed refresh keeps the last answer and shows the error beside it; a new subject that fails shows none', async () => {
    const h = harness<string[]>()
    const first = h.loader.read(h.ask, false)
    h.asked[0]!.resolve(['a.ts'])
    await first
    const refresh = h.loader.read(h.ask, true)
    h.asked[1]!.reject(new Error('the host did not answer'))
    await refresh
    expect(h.shown()).toEqual({ data: ['a.ts'], error: 'the host did not answer', loading: false })
    // The next answer clears the error
    const again = h.loader.read(h.ask, true)
    h.asked[2]!.resolve(['a.ts', 'b.ts'])
    await again
    expect(h.shown()).toEqual({ data: ['a.ts', 'b.ts'], error: null, loading: false })
    // Another subject: what was shown belongs to the old one
    const other = h.loader.read(h.ask, false)
    h.asked[3]!.reject(new Error('gone'))
    await other
    expect(h.shown()).toEqual({ data: undefined, error: 'gone', loading: false })
  })

  it('drops the answer to an older question, whichever arrives first', async () => {
    const h = harness<string>()
    const older = h.loader.read(h.ask, false)
    const newer = h.loader.read(h.ask, false)
    h.asked[1]!.resolve('beta')
    await newer
    h.asked[0]!.resolve('alpha')
    await older
    expect(h.shown().data).toBe('beta')

    // A failure of the older one does not cover the newer answer either
    const late = h.loader.read(h.ask, true)
    const latest = h.loader.read(h.ask, true)
    h.asked[3]!.resolve('gamma')
    await latest
    h.asked[2]!.reject(new Error('late'))
    await late
    expect(h.shown()).toEqual({ data: 'gamma', error: null, loading: false })
  })

  it('drops every answer on its way once the screen goes away', async () => {
    const h = harness<string>()
    const done = h.loader.read(h.ask, false)
    h.loader.drop()
    h.asked[0]!.resolve('alpha')
    await done
    expect(h.shown().data).toBeUndefined()
  })

  it('a question that throws before it asks is a failure too', async () => {
    const h = harness<string>()
    await h.loader.read(() => {
      throw new Error('no platform')
    }, false)
    expect(h.shown()).toEqual({ data: undefined, error: 'no platform', loading: false })
  })

  it('is idle with nothing to ask', async () => {
    const h = harness<string>()
    await h.loader.read(() => null, false)
    expect(h.shown()).toEqual({ data: undefined, error: null, loading: false })
  })
})

describe('loadErrorText', () => {
  it('reads an Error, a string a command rejected with, and an empty reason', () => {
    expect(loadErrorText(new Error('denied'))).toBe('denied')
    expect(loadErrorText('Could not read the folder')).toBe('Could not read the folder')
    expect(loadErrorText(new Error(''))).toBe('Unknown error')
  })
})
