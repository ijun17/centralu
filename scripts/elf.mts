/**
 * What an ELF executable is, read from its bytes: its type, its machine, the libraries it links by name
 * (`DT_NEEDED`) and the newest glibc it asks for (its version needs, `DT_VERNEED`: what `readelf -V` prints as
 * "Version needs section"). The release checks the keeper it puts in a Linux host-only package with it
 * (`host-package.mts`, docs/plans/remote-keeper.md §7), so the check runs on any machine, a Windows runner and a test
 * included, with no `file` or `ldd`. Only what the release builds is read: 64-bit, little-endian (x86-64, aarch64).
 */

/** `e_machine` values of the Linux platforms a hub installs on */
export const ELF_MACHINES: Record<string, number> = { 'linux-x64': 0x3e, 'linux-arm64': 0xb7 }

/** `e_type`: a fixed-address executable, or a position-independent one (what Rust links by default) */
export const ET_EXEC = 2
export const ET_DYN = 3

/**
 * `glibc`: the highest `GLIBC_x.y[.z]` among the version needs, as numbers (`[2, 34]`); null when they name none, as in
 * a statically linked file. A version need marked weak (`vna_flags` `VER_FLG_WEAK`) is left out: the loader starts a file
 * whose weak version is missing (Rust's std asks for `pidfd_spawnp` that way). `interp`: it names a program interpreter
 * (`PT_INTERP`), as an executable does and a shared library does not
 */
export type ElfFacts = { type: number; machine: number; needed: string[]; glibc: number[] | null; interp: boolean }

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const VER_FLG_WEAK = 0x2
const DT_NULL = 0n
const DT_NEEDED = 1n
const DT_STRTAB = 5n
const DT_VERNEED = 0x6ffffffen
const DT_VERNEEDNUM = 0x6fffffffn

/** Negative, 0 or positive as version `a` is older than, the same as, or newer than `b`; a missing part counts as 0 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * The glibc a version need asks for. `GLIBC_ABI_DT_RELR` names no number but exists from glibc 2.36 on (a file linked
 * with packed relocations); `GLIBC_PRIVATE` is no release at all
 */
function glibcOf(name: string): number[] | null {
  if (name === 'GLIBC_ABI_DT_RELR') return [2, 36]
  const m = /^GLIBC_(\d+(?:\.\d+)+)$/.exec(name)
  return m ? m[1]!.split('.').map(Number) : null
}

/** The facts, or a sentence saying why the bytes are not an ELF this can read */
export function readElf(b: Buffer): ElfFacts | string {
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46) return 'it is not an ELF file'
  if (b[4] !== 2 || b[5] !== 1) return 'it is not a 64-bit little-endian ELF'
  const type = b.readUInt16LE(16)
  const machine = b.readUInt16LE(18)
  const phoff = Number(b.readBigUInt64LE(32))
  const phentsize = b.readUInt16LE(54)
  const phnum = b.readUInt16LE(56)
  if (phentsize < 56 || phoff + phentsize * phnum > b.length) return 'its program headers run past the end of the file'
  const loads: { offset: number; vaddr: bigint; filesz: bigint }[] = []
  let interp = false
  let dynamic: { offset: number; size: number } | null = null
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    const pType = b.readUInt32LE(at)
    const offset = Number(b.readBigUInt64LE(at + 8))
    if (pType === PT_LOAD) loads.push({ offset, vaddr: b.readBigUInt64LE(at + 16), filesz: b.readBigUInt64LE(at + 32) })
    else if (pType === PT_INTERP) interp = true
    else if (pType === PT_DYNAMIC) dynamic = { offset, size: Number(b.readBigUInt64LE(at + 32)) }
  }
  // Statically linked: it links nothing by name
  if (!dynamic) return { type, machine, needed: [], glibc: null, interp }
  if (dynamic.offset + dynamic.size > b.length) return 'its dynamic section runs past the end of the file'
  const names: bigint[] = []
  let strtab: bigint | null = null
  let verneed: bigint | null = null
  let verneedNum = 0
  for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
    const tag = b.readBigInt64LE(at)
    const val = b.readBigUInt64LE(at + 8)
    if (tag === DT_NULL) break
    if (tag === DT_NEEDED) names.push(val)
    else if (tag === DT_STRTAB) strtab = val
    else if (tag === DT_VERNEED) verneed = val
    else if (tag === DT_VERNEEDNUM) verneedNum = Number(val)
  }
  if (names.length === 0 && verneed === null) return { type, machine, needed: [], glibc: null, interp }
  if (strtab === null) return 'it links libraries but has no string table'
  // The dynamic section names its tables by their address once loaded: find the segment that holds each
  const fileAt = (addr: bigint): number | null => {
    const seg = loads.find((l) => addr >= l.vaddr && addr < l.vaddr + l.filesz)
    return seg ? seg.offset + Number(addr - seg.vaddr) : null
  }
  const base = fileAt(strtab)
  if (base === null) return 'its string table is in no loaded segment'
  const string = (off: number): string | null => {
    const start = base + off
    const end = start < b.length ? b.indexOf(0, start) : -1
    return end < 0 ? null : b.toString('latin1', start, end)
  }
  const needed: string[] = []
  for (const n of names) {
    const name = string(Number(n))
    if (name === null) return 'a library name runs past the end of the file'
    needed.push(name)
  }
  // One Elf64_Verneed per library (16 bytes: version, count, file, aux, next), each with `count` Elf64_Vernaux
  // (16 bytes: hash, flags, other, name, next); `aux` and `next` count from the entry they are in
  let glibc: number[] | null = null
  if (verneed !== null) {
    let at = fileAt(verneed)
    if (at === null) return 'its version needs are in no loaded segment'
    for (let i = 0; i < verneedNum; i++) {
      if (at + 16 > b.length) return 'its version needs run past the end of the file'
      const count = b.readUInt16LE(at + 2)
      let aux = at + b.readUInt32LE(at + 8)
      for (let j = 0; j < count; j++) {
        if (aux + 16 > b.length) return 'its version needs run past the end of the file'
        const name = string(b.readUInt32LE(aux + 8))
        if (name === null) return 'a version name runs past the end of the file'
        const v = b.readUInt16LE(aux + 4) & VER_FLG_WEAK ? null : glibcOf(name)
        if (v && (!glibc || compareVersions(v, glibc) > 0)) glibc = v
        aux += b.readUInt32LE(aux + 12)
      }
      const next = b.readUInt32LE(at + 12)
      if (!next) break
      at += next
    }
  }
  return { type, machine, needed, glibc, interp }
}
