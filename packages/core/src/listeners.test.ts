import { describe, expect, it, vi } from 'vitest'
import { createListeners } from './listeners.js'

describe('createListeners', () => {
  it('hands the value to every listener, and add returns the disposer', () => {
    const l = createListeners<number>(() => {})
    const a = vi.fn()
    const b = vi.fn()
    const offA = l.add(a)
    l.add(b)
    l.emit(1)
    offA()
    l.emit(2)
    expect(a.mock.calls).toEqual([[1]])
    expect(b.mock.calls).toEqual([[1], [2]])
    expect(l.size).toBe(1)
  })

  it('isolates a listener that throws: reported, and the others still hear it', () => {
    const onError = vi.fn()
    const l = createListeners<string>(onError)
    const boom = new Error('boom')
    const after = vi.fn()
    l.add(() => {
      throw boom
    })
    l.add(after)
    expect(() => l.emit('x')).not.toThrow()
    expect(after).toHaveBeenCalledWith('x')
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('walks a snapshot: a listener removed or added during an emit changes the next one only', () => {
    const l = createListeners(() => {})
    const second = vi.fn()
    const late = vi.fn()
    let off2 = () => {}
    l.add(() => {
      off2()
      l.add(late)
    })
    off2 = l.add(second)
    l.emit()
    expect(second).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
    l.emit()
    expect(second).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('clears every listener', () => {
    const l = createListeners(() => {})
    const a = vi.fn()
    l.add(a)
    l.clear()
    l.emit()
    expect(a).not.toHaveBeenCalled()
    expect(l.size).toBe(0)
  })
})
