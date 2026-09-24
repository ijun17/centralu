import { mkdtemp, readdir, writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAttachments, saveAttachment, sweepAttachments } from './attachments.js'

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

/**
 * 세션 id는 경로 조각이지 경로가 아니다 (#94).
 *
 * 고치기 전에 실측한 것을 그대로 잰다: `clearAttachments('../../Documents')`가 첨부
 * 뿌리 두 단계 위의 폴더를 `recursive: true`로 지웠고, 같은 id를 받은 `saveAttachment`가
 * 그 자리에 공격자가 고른 확장자로 파일을 만들었다.
 */
describe('세션 id가 경로를 벗어나면 거절한다 (#94)', () => {
  it('지우기: 첨부 뿌리 밖의 폴더는 건드리지 못한다', async () => {
    const victim = join(dir, 'Documents')
    await mkdir(join(victim, 'nested'), { recursive: true })
    await writeFile(join(victim, 'nested', 'taxes.txt'), '중요')

    // dataRoot()가 dir이므로 attachments/ 기준 '../../Documents'가 곧 이 폴더다
    await expect(clearAttachments('../../Documents')).rejects.toThrow(/Not a session id/)
    expect(await readdir(join(victim, 'nested'))).toEqual(['taxes.txt'])
  })

  it('쓰기: 첨부 뿌리 밖에는 파일을 만들지 못한다', async () => {
    const outside = join(dir, 'LaunchAgents')
    await expect(
      saveAttachment('../../LaunchAgents', 'x.plist', 'text/plain', Buffer.from('pwned').toString('base64')),
    ).rejects.toThrow(/Not a session id/)
    await expect(readdir(outside)).rejects.toThrow()
  })

  it('평범한 id는 그대로 된다 — 저장하고, 지우면 사라진다', async () => {
    const id = randomUUID()
    const att = await saveAttachment(id, 'shot.png', 'image/png', Buffer.from('png').toString('base64'))
    expect(att.path.startsWith(join(dir, 'attachments', id) + sep)).toBe(true)
    expect(await readdir(join(dir, 'attachments', id))).toHaveLength(1)

    await clearAttachments(id)
    await expect(readdir(join(dir, 'attachments', id))).rejects.toThrow()
  })
})
