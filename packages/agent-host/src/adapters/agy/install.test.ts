import { describe, expect, it } from 'vitest'
import { runsAntigravity } from '../../os.js'
import { findAgy } from './install.js'

describe('where agy runs', () => {
  it('is macOS and Linux in this version', () => {
    expect(runsAntigravity('darwin')).toBe(true)
    expect(runsAntigravity('linux')).toBe(true)
    expect(runsAntigravity('win32')).toBe(false)
  })

  it('is not found on Windows although a file named agy is on PATH', () => {
    expect(findAgy({ PATH: '/usr/bin' }, 'win32')).toBeNull()
  })
})
