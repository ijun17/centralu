import { describe, expect, it } from 'vitest'
import { KEY_STEP, keyResize } from './ResizeHandle.jsx'

const k = (key: string, shiftKey = false) => ({ key, shiftKey })

describe('keyResize (#842 item 11): the keyboard moves a resize handle', () => {
  it('grows with the arrow that points the way the edge moves, and shrinks with the other', () => {
    expect(keyResize(k('ArrowRight'), 'right', 300, 200, 500)).toBe(300 + KEY_STEP)
    expect(keyResize(k('ArrowLeft'), 'right', 300, 200, 500)).toBe(300 - KEY_STEP)
    expect(keyResize(k('ArrowLeft'), 'left', 300, 200, 500)).toBe(300 + KEY_STEP)
    expect(keyResize(k('ArrowRight'), 'left', 300, 200, 500)).toBe(300 - KEY_STEP)
    expect(keyResize(k('ArrowUp'), 'top', 300, 200, 500)).toBe(300 + KEY_STEP)
    expect(keyResize(k('ArrowDown'), 'top', 300, 200, 500)).toBe(300 - KEY_STEP)
  })

  it('takes a bigger step with Shift, and stays inside the limits', () => {
    expect(keyResize(k('ArrowRight', true), 'right', 300, 200, 500)).toBe(300 + KEY_STEP * 4)
    expect(keyResize(k('ArrowRight'), 'right', 495, 200, 500)).toBe(500)
    expect(keyResize(k('ArrowLeft'), 'right', 205, 200, 500)).toBe(200)
    expect(keyResize(k('Home'), 'right', 300, 200, 500)).toBe(200)
    expect(keyResize(k('End'), 'right', 300, 200, 500)).toBe(500)
  })

  it('is not a resize for other keys or with a modifier', () => {
    expect(keyResize(k('ArrowUp'), 'right', 300, 200, 500)).toBeNull()
    expect(keyResize(k('a'), 'left', 300, 200, 500)).toBeNull()
    expect(keyResize({ key: 'ArrowRight', shiftKey: false, metaKey: true }, 'right', 300, 200, 500)).toBeNull()
  })
})
