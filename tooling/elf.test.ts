/**
 * `scripts/elf.mts`: what the release reads from the keeper it puts in a Linux host-only package
 * (docs/plans/remote-keeper.md §7, step 1), with no `file` or `ldd`.
 */
import { describe, expect, it } from 'vitest'
import { ELF_MACHINES, readElf } from '../scripts/elf.mjs'
import { fakeElf } from './elf.test-helpers.js'

describe('readElf', () => {
  it('reads the type, the machine and every library linked by name', () => {
    const needed = ['libgcc_s.so.1', 'libc.so.6', 'ld-linux-x86-64.so.2']
    expect(readElf(fakeElf({ machine: ELF_MACHINES['linux-x64']!, needed }))).toEqual({ type: 3, machine: 0x3e, needed })
    expect(readElf(fakeElf({ machine: ELF_MACHINES['linux-arm64']!, type: 2 }))).toEqual({ type: 2, machine: 0xb7, needed: [] })
  })

  it('says why it cannot read what is not a 64-bit little-endian ELF, or is cut short', () => {
    expect(readElf(Buffer.from('MZ\x90\x00'.padEnd(80, '\0'), 'latin1'))).toBe('not an ELF file')
    const elf = fakeElf({ machine: 0x3e, needed: ['libc.so.6'] })
    const thirtyTwo = Buffer.from(elf)
    thirtyTwo[4] = 1
    expect(readElf(thirtyTwo)).toBe('not a 64-bit little-endian ELF')
    expect(readElf(elf.subarray(0, 100))).toMatch(/past the end of the file$/)
  })
})
