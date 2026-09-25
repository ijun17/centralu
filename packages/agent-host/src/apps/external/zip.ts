import { inflateRawSync } from 'node:zlib'

/**
 * zip 읽기 (M4 E-3) — 가져올 앱의 묶음을 **판정하며** 푼다. 라이브러리를 들이지 않고 여기서 읽는 이유는 셋이다.
 *
 *   1. 막을 것이 이 파일의 모양에 달려 있다: 항목 이름(zip slip), 링크 항목, 선언한 크기와 실제로 풀린 크기(zip 폭탄), 암호.
 *      범용 라이브러리는 이것들을 "풀어 주는" 쪽으로 기본값을 둔다. 여기서는 모르는 것은 거절한다.
 *   2. 풀어서 쓰는 곳을 우리가 정한다: 이 파일은 바이트만 돌려주고, 경로를 만들고 파일을 쓰는 것은 부른 쪽(`imports.ts`)이
 *      검사한 이름으로 한다 — 검사한 문자열이 곧 쓰는 문자열이다.
 *   3. 필요한 것이 작다: 저장(0)과 deflate(8) 두 방식, ZIP64 없음(우리 상한은 4GiB에 한참 못 미친다).
 *
 * 규격은 PKWARE APPNOTE 6.3.x. 중앙 디렉터리가 정본이다(지역 머리의 크기는 데이터 설명자가 있으면 0이다).
 */

export class ZipError extends Error {
  readonly code = 'internal'
}

export type ZipEntry = {
  /** 항목 이름 그대로 (UTF-8). 디렉터리는 `/`로 끝난다 */
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
  method: number
  compressedSize: number
  /** 중앙 디렉터리가 선언한 풀린 크기 — 풀 때 이것과 실제를 대 본다 */
  size: number
  crc: number
  offset: number
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50
/** 주석까지 포함해 끝에서 거꾸로 찾는 범위 — 주석은 최대 65535바이트다 */
const EOCD_SEARCH = 22 + 0xffff

/** 중앙 디렉터리를 읽는다 — 항목 수가 `maxEntries`를 넘으면 읽기 전에 거절한다 */
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
    // UTF-8로 읽히지 않는 이름(옛 코드 페이지)은 추측하지 않는다 — 추측한 이름으로 파일을 쓰면 사람이 본 목록과 다르다
    if (name.includes('�')) throw new ZipError('An entry name is not UTF-8; re-create the archive with UTF-8 names')
    if (flags & 0x1) throw new ZipError(`Encrypted entries are not supported: ${name}`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported')
    out.push({ name, kind: kindOf(name, madeBy, external), method, compressedSize, size, crc, offset })
    p = nameEnd + extraLen + commentLen
  }
  return out
}

/**
 * 항목의 종류. 유닉스에서 만든 묶음(만든 곳 3, macOS 19)은 외부 속성의 위 16비트가 모드다 — 링크(`S_IFLNK`)는 거기서만
 * 알 수 있다. 링크를 파일로 풀면 그 내용(가리키는 경로)이 파일이 되고, 링크로 풀면 zip slip의 가장 오래된 길이 된다.
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
 * 항목 하나의 내용. **선언한 크기만큼만** 푼다(`maxOutputLength`) — 풀린 것이 선언보다 크면 그 자리에서 멈춘다(zip 폭탄).
 * 선언과 실제 크기, CRC가 다르면 거절한다: 사람에게 보인 목록(선언한 크기)과 쓰는 파일이 같아야 한다.
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
      // 선언이 0이면 1로 — 빈 파일도 deflate 스트림은 있다. 1바이트라도 넘으면 선언을 어긴 것이다
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
