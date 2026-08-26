import { readFile, stat } from 'node:fs/promises'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * 경로만 실려 온 이미지(#40, imageView)를 화면에 그릴 수 있는 이벤트로 바꾼다.
 *
 * normalize는 순수 함수라 파일을 못 읽는다 — IO는 여기서 한다. 어떤 실패든
 * 이벤트는 나간다: 조용한 공백보다 이유 있는 상자가 낫다 (실패는 보이게).
 */

/** 확장자로 mime을 정한다 — 목록 밖이면 그리지 않고 이유를 말한다 */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** 8MB — 이벤트는 WS로 UI까지 가는 짐이다. 큰 파일은 경로가 이미 화면에 있다 */
export const IMAGE_MAX_BYTES = 8 * 1048576

export async function imageEventFromDisk(
  sessionId: string,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Promise<NormalizedEvent> {
  const fail = (note: string): NormalizedEvent => ({ type: 'message_image', sessionId, mime: '', data: '', path, note })
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIMES[ext]
  if (!mime) return fail(`표시할 수 없는 형식입니다 (.${ext})`)
  try {
    const s = await stat(path)
    if (s.size > maxBytes) return fail(`이미지가 너무 큽니다 (${Math.round(s.size / 1048576)}MB)`)
    const buf = await readFile(path)
    return { type: 'message_image', sessionId, mime, data: buf.toString('base64'), path }
  } catch (err) {
    // 파일이 이미 지워졌을 수 있다 — 그래도 무슨 일이 있었는지는 화면에 남는다
    return fail(`이미지를 읽지 못했습니다: ${(err as Error).message}`)
  }
}
