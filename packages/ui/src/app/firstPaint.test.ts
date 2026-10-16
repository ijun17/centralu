import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareFirstPaint } from './firstPaint.js'

const fontsOf = (load: (font: string) => Promise<unknown>) => ({ fonts: { load } }) as unknown as Pick<Document, 'fonts'>

afterEach(() => {
  vi.useRealTimers()
})

describe('prepareFirstPaint (#850 item 16)', () => {
  it('asks for both bundled fonts and settles once they are in', async () => {
    const asked: string[] = []
    await prepareFirstPaint(fontsOf(async (font) => asked.push(font)), 60_000)
    expect(asked).toEqual(['13px Pretendard', '12px D2Coding'])
  })

  it('settles after the wait when a font never arrives, so the window is not left blank', async () => {
    vi.useFakeTimers()
    let settled = false
    void prepareFirstPaint(fontsOf(() => new Promise(() => {})), 3000).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(2999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('settles rather than rejects when a font fails, and without a font API at all', async () => {
    await expect(prepareFirstPaint(fontsOf(() => Promise.reject(new Error('404'))), 60_000)).resolves.toBeUndefined()
    await expect(prepareFirstPaint({ fonts: undefined } as unknown as Pick<Document, 'fonts'>, 60_000)).resolves.toBeUndefined()
  })
})
