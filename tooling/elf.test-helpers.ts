/**
 * The smallest ELF64 little-endian file `scripts/elf.mts` reads as a whole executable: a header, one loaded segment
 * over the whole file, a dynamic section naming `needed` (when there is any), the version needs `versions` names (all
 * of them asked of the first library, as `readelf -V` would list them under it) and the string table those names are
 * in. Enough to test the release's check of a keeper without a Linux build at hand.
 */
export function fakeElf(o: { machine: number; type?: number; needed?: string[]; versions?: string[] }): Buffer {
  const needed = o.needed ?? []
  const versions = needed.length ? (o.versions ?? []) : []
  const phoff = 64
  const phnum = needed.length ? 2 : 1
  const strtabAt = phoff + 56 * phnum
  const strings = [...needed, ...versions]
  const names = Buffer.concat([Buffer.from([0]), ...strings.map((n) => Buffer.from(`${n}\0`, 'latin1'))])
  const offsets: number[] = []
  let off = 1
  for (const n of strings) {
    offsets.push(off)
    off += Buffer.byteLength(n, 'latin1') + 1
  }
  const verneedAt = Math.ceil((strtabAt + names.length) / 8) * 8
  const verneedSize = versions.length ? 16 + 16 * versions.length : 0
  const dynAt = verneedAt + verneedSize
  const dynEntries = needed.length ? needed.length + (versions.length ? 2 : 0) + 2 : 0
  const size = dynAt + dynEntries * 16
  const b = Buffer.alloc(size)
  b.writeUInt32BE(0x7f454c46, 0)
  b[4] = 2 // 64-bit
  b[5] = 1 // little-endian
  b[6] = 1 // version
  b.writeUInt16LE(o.type ?? 3, 16)
  b.writeUInt16LE(o.machine, 18)
  b.writeUInt32LE(1, 20)
  b.writeBigUInt64LE(BigInt(phoff), 32)
  b.writeUInt16LE(64, 52)
  b.writeUInt16LE(56, 54)
  b.writeUInt16LE(phnum, 56)
  // PT_LOAD: the whole file, loaded at address 0x400000
  const vbase = 0x400000n
  b.writeUInt32LE(1, phoff)
  b.writeBigUInt64LE(0n, phoff + 8)
  b.writeBigUInt64LE(vbase, phoff + 16)
  b.writeBigUInt64LE(BigInt(size), phoff + 32)
  b.writeBigUInt64LE(BigInt(size), phoff + 40)
  if (needed.length) {
    const ph = phoff + 56
    b.writeUInt32LE(2, ph) // PT_DYNAMIC
    b.writeBigUInt64LE(BigInt(dynAt), ph + 8)
    b.writeBigUInt64LE(vbase + BigInt(dynAt), ph + 16)
    b.writeBigUInt64LE(BigInt(dynEntries * 16), ph + 32)
    names.copy(b, strtabAt)
    if (versions.length) {
      // One Elf64_Verneed, for the first library, then its Elf64_Vernaux, one per version
      b.writeUInt16LE(1, verneedAt) // vn_version
      b.writeUInt16LE(versions.length, verneedAt + 2) // vn_cnt
      b.writeUInt32LE(offsets[0]!, verneedAt + 4) // vn_file
      b.writeUInt32LE(16, verneedAt + 8) // vn_aux
      // vn_next: 0, the last
      versions.forEach((_, i) => {
        const aux = verneedAt + 16 + 16 * i
        b.writeUInt16LE(i + 2, aux + 6) // vna_other
        b.writeUInt32LE(offsets[needed.length + i]!, aux + 8) // vna_name
        b.writeUInt32LE(i + 1 < versions.length ? 16 : 0, aux + 12) // vna_next
      })
    }
    let at = dynAt
    for (let i = 0; i < needed.length; i++) {
      b.writeBigInt64LE(1n, at) // DT_NEEDED
      b.writeBigUInt64LE(BigInt(offsets[i]!), at + 8)
      at += 16
    }
    b.writeBigInt64LE(5n, at) // DT_STRTAB, as an address
    b.writeBigUInt64LE(vbase + BigInt(strtabAt), at + 8)
    at += 16
    if (versions.length) {
      b.writeBigInt64LE(0x6ffffffen, at) // DT_VERNEED, as an address
      b.writeBigUInt64LE(vbase + BigInt(verneedAt), at + 8)
      b.writeBigInt64LE(0x6fffffffn, at + 16) // DT_VERNEEDNUM
      b.writeBigUInt64LE(1n, at + 24)
    }
    // DT_NULL: the zeros already there
  }
  return b
}
