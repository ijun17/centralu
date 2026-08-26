import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageEventFromDisk } from './images.js'

/**
 * imageView(#40)의 IO 절반 — 경로를 읽어 그릴 수 있는 이벤트로 바꾼다.
 * 계약: 어떤 실패든 이벤트는 나가고, data가 비면 note가 이유를 말한다.
 */

// 8×8 픽셀짜리 진짜 PNG (실측 프로브에서 쓴 것과 같은 파일)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFtFEIAJ2yAhH+Iz4jAAAAAElFTkSuQmCC'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-images-'))
  await writeFile(join(dir, 'dot.png'), Buffer.from(PNG_B64, 'base64'))
  await writeFile(join(dir, 'note.txt'), 'not an image')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('imageEventFromDisk', () => {
  it('읽을 수 있는 이미지는 base64와 mime을 채운다', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'dot.png'))
    expect(e).toMatchObject({ type: 'message_image', sessionId: 's1', mime: 'image/png', data: PNG_B64 })
  })

  it('목록 밖 확장자는 그리지 않고 이유를 말한다', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'note.txt'))
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('형식') })
  })

  it('상한을 넘는 파일은 크기를 말한다', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'dot.png'), 10)
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('너무 큽니다') })
  })

  it('없는 파일도 이벤트다 — 조용한 공백보다 이유 있는 상자', async () => {
    const e = await imageEventFromDisk('s1', join(dir, 'gone.png'))
    expect(e).toMatchObject({ data: '', note: expect.stringContaining('읽지 못했습니다') })
  })
})
