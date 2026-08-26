import { mkdtemp, readdir, writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sweepAttachments } from './attachments.js'

/**
 * 총량 상한 (#40 2차, 사용자 결정 500MB — 테스트는 작은 상한으로 같은 규칙을 잰다).
 * 계약: 넘치면 **오래된 파일부터**, 상한 아래로 내려올 때까지만.
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-att-'))
  process.env.CC_DATA_DIR = dir
})
afterEach(async () => {
  delete process.env.CC_DATA_DIR
  await rm(dir, { recursive: true, force: true })
})

async function put(session: string, name: string, bytes: number, ageSec: number): Promise<string> {
  const d = join(dir, 'attachments', session)
  await mkdir(d, { recursive: true })
  const p = join(d, name)
  await writeFile(p, Buffer.alloc(bytes, 1))
  const t = new Date(Date.now() - ageSec * 1000)
  await utimes(p, t, t)
  return p
}

describe('sweepAttachments', () => {
  it('상한 아래면 아무것도 지우지 않는다', async () => {
    await put('s1', 'a.png', 100, 60)
    expect(await sweepAttachments(1000)).toBe(0)
    expect(await readdir(join(dir, 'attachments', 's1'))).toEqual(['a.png'])
  })

  it('넘치면 오래된 것부터, 내려올 때까지만 지운다', async () => {
    await put('s1', 'old.png', 400, 300)
    await put('s2', 'mid.png', 400, 200)
    await put('s1', 'new.png', 400, 100)
    // 총 1200, 상한 900 → old만 지우면 800으로 내려온다
    expect(await sweepAttachments(900)).toBe(1)
    expect(await readdir(join(dir, 'attachments', 's1'))).toEqual(['new.png'])
    expect(await readdir(join(dir, 'attachments', 's2'))).toEqual(['mid.png'])
  })

  it('폴더가 아직 없어도 조용히 0이다', async () => {
    expect(await sweepAttachments(10)).toBe(0)
  })
})
