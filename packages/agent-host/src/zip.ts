import { inflateRawSync } from 'node:zlib'
import { errorMessage } from '@cc/protocol'

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
  /** The Unix mode an archive made on Unix records for the entry (file-type bits included); 0 for any other archive */
  mode: number
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
  return readZipEntriesFrom(buf.length, (pos, len) => buf.subarray(pos, pos + len), maxEntries)
}

/**
 * `readZipEntries` for an archive too large to hold in memory (Antigravity's, ~110 MB): only the end of the file and its
 * central directory are read, through `read(position, length)`, with the same checks
 */
export function readZipEntriesFrom(size: number, read: (pos: number, len: number) => Buffer, maxEntries: number): ZipEntry[] {
  const tailStart = Math.max(0, size - EOCD_SEARCH)
  const tail = read(tailStart, size - tailStart)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i
      break
    }
  }
  if (at < 0) throw new ZipError('This is not a zip file (no end of central directory)')
  const end = tailStart + at
  const disk = tail.readUInt16LE(at + 4)
  const cdDisk = tail.readUInt16LE(at + 6)
  const total = tail.readUInt16LE(at + 10)
  const cdSize = tail.readUInt32LE(at + 12)
  const cdOffset = tail.readUInt32LE(at + 16)
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Split zip archives are not supported')
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
  if (total > maxEntries) throw new ZipError(`The archive has ${total} entries; at most ${maxEntries} are accepted`)
  if (cdOffset + cdSize > end) throw new ZipError('The zip file is damaged (central directory out of range)')

  // The directory up to the end record, read on its own; `p` counts from the directory's start
  const cd = read(cdOffset, end - cdOffset)
  const limit = cd.length
  const out: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < total; n++) {
    if (p + 46 > limit || cd.readUInt32LE(p) !== CEN) throw new ZipError('The zip file is damaged (bad central directory entry)')
    const madeBy = cd.readUInt16LE(p + 4)
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    const crc = cd.readUInt32LE(p + 16)
    const compressedSize = cd.readUInt32LE(p + 20)
    const size = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const external = cd.readUInt32LE(p + 38)
    const offset = cd.readUInt32LE(p + 42)
    const nameEnd = p + 46 + nameLen
    if (nameEnd > limit) throw new ZipError('The zip file is damaged (entry name out of range)')
    const name = cd.toString('utf8', p + 46, nameEnd)
    // A name that does not decode as UTF-8 (an old code page) is never guessed at — writing a file under a guessed name would differ from the list the person saw
    if (name.includes('�')) throw new ZipError('An entry name is not UTF-8; re-create the archive with UTF-8 names')
    if (flags & 0x1) throw new ZipError(`Encrypted entries are not supported: ${name}`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
    const mode = unixMode(madeBy, external)
    out.push({ name, kind: kindOf(name, mode, external), mode, method, compressedSize, size, crc, offset })
    p = nameEnd + extraLen + commentLen
  }
  return out
}

/** For a bundle made on Unix (made-by host 3, macOS 19), the upper 16 bits of the external attributes are the mode */
function unixMode(madeBy: number, external: number): number {
  const host = madeBy >> 8
  return host === 3 || host === 19 ? external >>> 16 : 0
}

/**
 * An entry's kind. A symlink (`S_IFLNK`) can only be recognized by its Unix mode. Unpacking a
 * symlink as a regular file turns its content (the path it points at) into a file; unpacking it as
 * an actual symlink is the oldest form of a zip-slip attack.
 */
function kindOf(name: string, mode: number, external: number): ZipEntry['kind'] {
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
  const raw = zipEntryBytes(buf, e)
  let data: Buffer
  if (e.method === 0) data = raw
  else if (e.method === 8) {
    try {
      // A declared size of 0 is treated as 1 — even an empty file has a deflate stream. Exceeding it by even one byte breaks the declaration
      data = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) })
    } catch (err) {
      throw new ZipError(`Could not unpack ${e.name}: ${errorMessage(err)}`)
    }
  } else throw new ZipError(`Unsupported compression method ${e.method}: ${e.name}`)
  if (data.length !== e.size) throw new ZipError(`${e.name} unpacks to ${data.length} bytes, not the ${e.size} it declares`)
  if (crc32(data) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum mismatch)`)
  return data
}

/** An entry's bytes as stored (compressed by its `method`), found through its local header */
export function zipEntryBytes(buf: Buffer, e: ZipEntry): Buffer {
  const start = zipEntryStart(buf.length, (pos, len) => buf.subarray(pos, pos + len), e)
  return buf.subarray(start, start + e.compressedSize)
}

/** Where an entry's stored bytes begin, read through its local header (`readZipEntriesFrom`'s `read`), checked to lie inside the file */
export function zipEntryStart(size: number, read: (pos: number, len: number) => Buffer, e: ZipEntry): number {
  const head = e.offset + 30 <= size ? read(e.offset, 30) : null
  if (!head || head.length < 30 || head.readUInt32LE(0) !== LOC) throw new ZipError(`The zip file is damaged (bad local header): ${e.name}`)
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  if (start + e.compressedSize > size) throw new ZipError(`The zip file is damaged (data out of range): ${e.name}`)
  return start
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
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
