/**
 * The smallest ELF64 little-endian file `scripts/elf.mts` reads as a whole executable: a header, one loaded segment
 * over the whole file, a dynamic section naming `needed` (when there is any) and the string table those names are in.
 * Enough to test the release's check of a keeper without a Linux build at hand.
 */
export function fakeElf(o: { machine: number; type?: number; needed?: string[] }): Buffer {
  const needed = o.needed ?? []
  const phoff = 64
  const phnum = needed.length ? 2 : 1
  const strtabAt = phoff + 56 * phnum
  const names = Buffer.concat([Buffer.from([0]), ...needed.map((n) => Buffer.from(`${n}\0`, 'latin1'))])
  const dynAt = Math.ceil((strtabAt + names.length) / 8) * 8
  const dynEntries = needed.length ? needed.length + 2 : 0
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
    let at = dynAt
    let off = 1
    for (const n of needed) {
      b.writeBigInt64LE(1n, at) // DT_NEEDED
      b.writeBigUInt64LE(BigInt(off), at + 8)
      off += Buffer.byteLength(n, 'latin1') + 1
      at += 16
    }
    b.writeBigInt64LE(5n, at) // DT_STRTAB, as an address
    b.writeBigUInt64LE(vbase + BigInt(strtabAt), at + 8)
    // DT_NULL: the zeros already there
  }
  return b
}
