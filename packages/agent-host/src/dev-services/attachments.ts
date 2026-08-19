import { mkdir, writeFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Attachment } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'

/**
 * 첨부 저장 (D-1).
 *
 * 이미지를 base64로 DB에 넣지 않는다 — 대화 기록이 급격히 커지고 FTS 인덱스가 오염된다.
 * 파일로 저장하고 경로만 주고받는다. 세션을 지우면 함께 정리된다.
 */
// **함수다.** 모듈 로드 시점에 정하면 host가 데이터 폴더를 고정하기 전의 값이 박힌다
const root = () => join(dataRoot(), 'attachments')

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

export async function saveAttachment(
  sessionId: string,
  name: string,
  mime: string,
  dataBase64: string,
): Promise<Attachment> {
  const dir = join(root(), sessionId)
  await mkdir(dir, { recursive: true })
  const ext = extname(name) || EXT[mime] || ''
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  const buf = Buffer.from(dataBase64, 'base64')
  await writeFile(file, buf)
  return { kind: mime.startsWith('image/') ? 'image' : 'file', path: file, name, mime, bytes: buf.length }
}

/** 세션 아카이브·삭제 시 함께 정리 */
export async function clearAttachments(sessionId: string): Promise<void> {
  await rm(join(root(), sessionId), { recursive: true, force: true })
}
