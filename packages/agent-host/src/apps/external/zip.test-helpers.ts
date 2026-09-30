import { deflateRawSync } from 'node:zlib'
import { crc32 } from './zip.js'

/**
 * A zip writer for tests — **it has to be able to build bad archives.** Names with `..`, absolute
 * paths, symlink entries, a lying declared size. The system's `zip` fixes or rejects these, so it
 * cannot be used to test the import path's judgment. (Test-only. The runtime never imports this.)
 */
export type ZipSpec = {
  name: string
  data?: Buffer | string
  /** Unix mode (with the file-type bits) — setting it makes the entry look "made on Unix". A symlink is 0o120777. */
  mode?: number
  /** 0 for stored, 8 for deflate (the default) */
  method?: 0 | 8
  /** The uncompressed size to declare — set it differently from the real size to fake a zip bomb */
  declaredSize?: number
}

export function makeZip(entries: ZipSpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '')
    const method = e.method ?? (e.name.endsWith('/') ? 0 : 8)
    const body = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(raw)
    const size = e.declaredSize ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.mode !== undefined ? (3 << 8) | 20 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(e.mode !== undefined ? (e.mode << 16) >>> 0 : e.name.endsWith('/') ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
