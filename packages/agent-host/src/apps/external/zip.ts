import { inflateRawSync } from 'node:zlib'

/**
 * Zip reading (M4 E-3) — unpacks an imported app's bundle **while validating it**. Three reasons
 * this is read here rather than pulling in a library.
 *
 *   1. What has to be blocked depends on this file's own shape: entry names (zip slip), symlink
 *      entries, a declared size that disagrees with the actual unpacked size (a zip bomb),
 *      encryption. A general-purpose library defaults toward "unpacking it anyway" for these. Here,
 *      anything unrecognized is rejected.
 *   2. We decide where the unpacked output is written: this file only returns bytes, and building
 *      the path and writing the file is the caller's job (`imports.ts`), using the name it has
 *      already validated — the validated string is the string that gets used.
 *   3. What is actually needed is small: two methods, stored (0) and deflate (8), no ZIP64 (our cap
 *      is well under 4GiB).
 *
 * The format is PKWARE APPNOTE 6.3.x. The central directory is authoritative (the size in the local
 * header is 0 when a data descriptor is present).
 */

export class ZipError extends Error {
  readonly code = 'internal'
}

export type ZipEntry = {
  /** The entry name verbatim (UTF-8). A directory ends with `/` */
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
  method: number
  compressedSize: number
  /** The unpacked size the central directory declares — checked against the actual size when unpacked */
  size: number
  crc: number
  offset: number
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50
/** How far back from the end to search, including the comment — a comment is at most 65535 bytes */
const EOCD_SEARCH = 22 + 0xffff

/** Reads the central directory — if the entry count exceeds `maxEntries`, rejects before reading further */
export function readZipEntries(buf: Buffer, maxEntries: number): ZipEntry[] {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - EOCD_SEARCH); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i
      break
    }
  }
  if (end < 0) throw new ZipError('This is not a zip file (no end of central directory)')
  const disk = buf.readUInt16LE(end + 4)
  const cdDisk = buf.readUInt16LE(end + 6)
  const total = buf.readUInt16LE(end + 10)
  const cdSize = buf.readUInt32LE(end + 12)
  const cdOffset = buf.readUInt32LE(end + 16)
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Split zip archives are not supported')
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
  if (total > maxEntries) throw new ZipError(`The archive has ${total} entries; at most ${maxEntries} are accepted`)
  if (cdOffset + cdSize > end) throw new ZipError('The zip file is damaged (central directory out of range)')

  const out: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CEN) throw new ZipError('The zip file is damaged (bad central directory entry)')
    const madeBy = buf.readUInt16LE(p + 4)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const offset = buf.readUInt32LE(p + 42)
    const nameEnd = p + 46 + nameLen
    if (nameEnd > end) throw new ZipError('The zip file is damaged (entry name out of range)')
    const name = buf.toString('utf8', p + 46, nameEnd)
    // A name that does not decode as UTF-8 (an old code page) is never guessed at — writing a file under a guessed name would differ from the list the person saw
    if (name.includes('�')) throw new ZipError('An entry name is not UTF-8; re-create the archive with UTF-8 names')
    if (flags & 0x1) throw new ZipError(`Encrypted entries are not supported: ${name}`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
    out.push({ name, kind: kindOf(name, madeBy, external), method, compressedSize, size, crc, offset })
    p = nameEnd + extraLen + commentLen
  }
  return out
}

/**
 * An entry's kind. For a bundle made on Unix (made-by host 3, macOS 19), the upper 16 bits of the
 * external attributes are the mode — a symlink (`S_IFLNK`) can only be recognized there. Unpacking a
 * symlink as a regular file turns its content (the path it points at) into a file; unpacking it as
 * an actual symlink is the oldest form of a zip-slip attack.
 */
function kindOf(name: string, madeBy: number, external: number): ZipEntry['kind'] {
  const host = madeBy >> 8
  const mode = host === 3 || host === 19 ? external >>> 16 : 0
  const type = mode & 0o170000
  if (type === 0o120000) return 'link'
  if (name.endsWith('/') || type === 0o040000 || (external & 0x10) !== 0) return 'dir'
  if (type !== 0 && type !== 0o100000) return 'other'
  return 'file'
}

/**
 * The content of one entry. Unpacks **only up to the declared size** (`maxOutputLength`) — if the
 * unpacked output would exceed it, stops right there (a zip bomb). Rejects if the declared size, the
 * actual size, or the CRC disagree: the file that gets written must match the list (with its
 * declared size) the person saw.
 */
export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOC) throw new ZipError(`The zip file is damaged (bad local header): ${e.name}`)
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
  if (start + e.compressedSize > buf.length) throw new ZipError(`The zip file is damaged (data out of range): ${e.name}`)
  const raw = buf.subarray(start, start + e.compressedSize)
  let data: Buffer
  if (e.method === 0) data = raw
  else if (e.method === 8) {
    try {
      // A declared size of 0 is treated as 1 — even an empty file has a deflate stream. Exceeding it by even one byte breaks the declaration
      data = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) })
    } catch (err) {
      throw new ZipError(`Could not unpack ${e.name}: ${(err as Error).message}`)
    }
  } else throw new ZipError(`Unsupported compression method ${e.method}: ${e.name}`)
  if (data.length !== e.size) throw new ZipError(`${e.name} unpacks to ${data.length} bytes, not the ${e.size} it declares`)
  if (crc32(data) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum mismatch)`)
  return data
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
