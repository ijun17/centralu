/**
 * `scripts/elf.mts`: what the release reads from the keeper it puts in a Linux host-only package
 * (docs/plans/remote-keeper.md §7, step 1), with no `file` or `ldd`.
 */
import { describe, expect, it } from 'vitest'
import { compareVersions, ELF_MACHINES, readElf } from '../scripts/elf.mjs'
import { fakeElf } from './elf.test-helpers.js'

describe('readElf', () => {
  it('reads the type, the machine and every library linked by name', () => {
    const needed = ['libgcc_s.so.1', 'libc.so.6', 'ld-linux-x86-64.so.2']
    expect(readElf(fakeElf({ machine: ELF_MACHINES['linux-x64']!, needed }))).toEqual({ type: 3, machine: 0x3e, needed, glibc: null, interp: true })
    expect(readElf(fakeElf({ machine: ELF_MACHINES['linux-arm64']!, type: 2 }))).toEqual({ type: 2, machine: 0xb7, needed: [], glibc: null, interp: true })
  })

  // What `readelf -V` lists under "Version needs section": the release refuses a keeper newer than a remote's glibc
  it('reads the newest glibc the version needs ask for, by number and not as text', () => {
    const glibc = (versions: string[]) => {
      const elf = readElf(fakeElf({ machine: 0x3e, needed: ['libc.so.6'], versions }))
      return typeof elf === 'string' ? elf : elf.glibc
    }
    expect(glibc(['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.17', 'GLIBC_PRIVATE'])).toEqual([2, 34])
    expect(glibc(['GLIBC_2.9', 'GLIBC_2.10'])).toEqual([2, 10])
    expect(glibc(['GLIBC_2.34', 'GLIBC_ABI_DT_RELR'])).toEqual([2, 36])
    expect(glibc(['GCC_3.0'])).toBeNull()
  })

  // Ubuntu 24.04's Rust std asks weakly for GLIBC_2.39 (pidfd_spawnp): the loader starts the file without it
  it('leaves out a weak version need, which glibc does not refuse when missing', () => {
    const elf = readElf(fakeElf({ machine: 0x3e, needed: ['libc.so.6'], versions: ['GLIBC_2.39', 'GLIBC_2.34'], weak: ['GLIBC_2.39'] }))
    expect(typeof elf === 'string' ? elf : elf.glibc).toEqual([2, 34])
  })

  it('tells an executable from a shared library by its program interpreter', () => {
    const facts = (interp: boolean) => readElf(fakeElf({ machine: 0x3e, needed: ['libc.so.6'], interp }))
    expect(facts(true)).toMatchObject({ interp: true })
    expect(facts(false)).toMatchObject({ interp: false })
  })

  it('orders versions part by part', () => {
    expect(compareVersions([2, 35], [2, 34])).toBeGreaterThan(0)
    expect(compareVersions([2, 9], [2, 10])).toBeLessThan(0)
    expect(compareVersions([2, 34], [2, 34, 0])).toBe(0)
  })

  it('says why it cannot read what is not a 64-bit little-endian ELF, or is cut short', () => {
    expect(readElf(Buffer.from('MZ\x90\x00'.padEnd(80, '\0'), 'latin1'))).toBe('it is not an ELF file')
    const elf = fakeElf({ machine: 0x3e, needed: ['libc.so.6'] })
    const thirtyTwo = Buffer.from(elf)
    thirtyTwo[4] = 1
    expect(readElf(thirtyTwo)).toBe('it is not a 64-bit little-endian ELF')
    expect(readElf(elf.subarray(0, 100))).toMatch(/past the end of the file$/)
  })
})
