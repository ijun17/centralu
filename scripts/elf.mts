/**
 * What an ELF executable is, read from its bytes: its type, its machine and the libraries it links by name
 * (`DT_NEEDED`). The release checks the keeper it puts in a Linux host-only package with it
 * (`host-package.mts`, docs/plans/remote-keeper.md §7), so the check runs on any machine, a Windows runner and a test
 * included, with no `file` or `ldd`. Only what the release builds is read: 64-bit, little-endian (x86-64, aarch64).
 */

/** `e_machine` values of the Linux platforms a hub installs on */
export const ELF_MACHINES: Record<string, number> = { 'linux-x64': 0x3e, 'linux-arm64': 0xb7 }

/** `e_type`: a fixed-address executable, or a position-independent one (what Rust links by default) */
export const ET_EXEC = 2
export const ET_DYN = 3

export type ElfFacts = { type: number; machine: number; needed: string[] }

const PT_LOAD = 1
const PT_DYNAMIC = 2
const DT_NULL = 0n
const DT_NEEDED = 1n
const DT_STRTAB = 5n

/** The facts, or a sentence saying why the bytes are not an ELF this can read */
export function readElf(b: Buffer): ElfFacts | string {
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46) return 'not an ELF file'
  if (b[4] !== 2 || b[5] !== 1) return 'not a 64-bit little-endian ELF'
  const type = b.readUInt16LE(16)
  const machine = b.readUInt16LE(18)
  const phoff = Number(b.readBigUInt64LE(32))
  const phentsize = b.readUInt16LE(54)
  const phnum = b.readUInt16LE(56)
  if (phentsize < 56 || phoff + phentsize * phnum > b.length) return 'its program headers run past the end of the file'
  const loads: { offset: number; vaddr: bigint; filesz: bigint }[] = []
  let dynamic: { offset: number; size: number } | null = null
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    const pType = b.readUInt32LE(at)
    const offset = Number(b.readBigUInt64LE(at + 8))
    if (pType === PT_LOAD) loads.push({ offset, vaddr: b.readBigUInt64LE(at + 16), filesz: b.readBigUInt64LE(at + 32) })
    else if (pType === PT_DYNAMIC) dynamic = { offset, size: Number(b.readBigUInt64LE(at + 32)) }
  }
  // Statically linked: it links nothing by name
  if (!dynamic) return { type, machine, needed: [] }
  if (dynamic.offset + dynamic.size > b.length) return 'its dynamic section runs past the end of the file'
  const names: bigint[] = []
  let strtab: bigint | null = null
  for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
    const tag = b.readBigInt64LE(at)
    const val = b.readBigUInt64LE(at + 8)
    if (tag === DT_NULL) break
    if (tag === DT_NEEDED) names.push(val)
    else if (tag === DT_STRTAB) strtab = val
  }
  if (names.length === 0) return { type, machine, needed: [] }
  if (strtab === null) return 'it links libraries but has no string table'
  // The string table is named by its address once loaded: find the segment that holds it
  const seg = loads.find((l) => strtab! >= l.vaddr && strtab! < l.vaddr + l.filesz)
  if (!seg) return 'its string table is in no loaded segment'
  const base = seg.offset + Number(strtab - seg.vaddr)
  const needed: string[] = []
  for (const n of names) {
    const start = base + Number(n)
    const end = b.indexOf(0, start)
    if (start >= b.length || end < 0) return 'a library name runs past the end of the file'
    needed.push(b.toString('latin1', start, end))
  }
  return { type, machine, needed }
}
