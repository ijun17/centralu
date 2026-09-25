import { deflateRawSync } from 'node:zlib'
import { crc32 } from './zip.js'

/**
 * 시험용 zip 쓰기 — **나쁜 묶음을 만들 수 있어야 한다.** 이름에 `..`, 절대 경로, 링크 항목, 거짓 크기. 시스템의 `zip`은 이런 것을
 * 고쳐서 쓰거나 거부하므로 가져오기의 판정을 시험할 수 없다. (시험 전용이다. 런타임은 이것을 임포트하지 않는다)
 */
export type ZipSpec = {
  name: string
  data?: Buffer | string
  /** 유닉스 모드(종류 비트 포함) — 주면 "유닉스에서 만든" 항목이 된다. 링크는 0o120777 */
  mode?: number
  /** 0 저장, 8 deflate (기본) */
  method?: 0 | 8
  /** 선언할 풀린 크기 — 실제와 다르게 적어 zip 폭탄을 흉내 낸다 */
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
